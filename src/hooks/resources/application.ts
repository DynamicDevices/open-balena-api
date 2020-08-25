import { sbvrUtils, hooks, permissions, errors } from '@balena/pinejs';

import { createActor } from '../../infra/auth/create-actor';
import { captureException } from '../../infra/error-handling';

import { DefaultApplicationType } from '../../features/application-types/application-types';
import { postDevices } from '../../features/device-proxy/device-proxy';
import { resolveDeviceType } from '../common';

const { BadRequestError, ConflictError, NotFoundError } = errors;

hooks.addPureHook('POST', 'resin', 'application', {
	POSTPARSE: createActor,
});

hooks.addPureHook('POST', 'resin', 'application', {
	POSTPARSE: async (args) => {
		const { req, request, api } = args;
		const appName = request.values.app_name;

		if (request.values.application_type == null) {
			request.values.application_type = DefaultApplicationType.id;
		}

		if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
			throw new BadRequestError('App name may only contain [a-zA-Z0-9_-].');
		}

		try {
			await resolveDeviceType(api, request, 'is_for__device_type');
			request.values.should_track_latest_release = true;
			if (request.values.slug == null) {
				request.values.slug = appName.toLowerCase();
			}
		} catch (err) {
			if (!(err instanceof ConflictError)) {
				captureException(err, 'Error in application postparse hook', { req });
			}
			throw err;
		}
	},
});

hooks.addPureHook('PATCH', 'resin', 'application', {
	PRERUN: async (args) => {
		const { request } = args;
		const appName = request.values.app_name;

		if (appName) {
			if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
				throw new BadRequestError('App name may only contain [a-zA-Z0-9_-].');
			}
			if (request.values.slug == null) {
				request.values.slug = appName.toLowerCase();
			}
			await sbvrUtils.getAffectedIds(args).then((ids) => {
				if (ids.length === 0) {
					return;
				}
				if (ids.length > 1) {
					throw new ConflictError(
						'Cannot rename multiple applications to the same name, please specify just one.',
					);
				}
			});
		}
	},
	POSTRUN: async ({ request }) => {
		const affectedIds = request.affectedIds!;
		if (
			request.values.should_be_running__release != null &&
			affectedIds.length !== 0
		) {
			// Only update apps if they have had their release changed.
			await postDevices({
				url: '/v1/update',
				req: permissions.root,
				filter: {
					belongs_to__application: { $in: affectedIds },
					is_running__release: {
						$ne: request.values.should_be_running__release,
					},
					should_be_running__release: null,
				},
				// Don't wait for the posts to complete, as they may take a long time and we've already sent the prompt to update.
				wait: false,
			});
		}
	},
});

hooks.addPureHook('DELETE', 'resin', 'application', {
	PRERUN: async (args) => {
		const appIds = await sbvrUtils.getAffectedIds(args);
		if (appIds.length === 0) {
			const { odataQuery } = args.request;
			if (odataQuery != null && odataQuery.key != null) {
				// If there's a specific app targeted we make sure we give a 404 for backwards compatibility
				throw new NotFoundError('Application(s) not found.');
			}
			return;
		}
		// find devices which are
		// not part of any of the applications that are about to be deleted
		// but run a release that belongs to any of the applications that
		// is about to be deleted
		const devices = await args.api.get({
			resource: 'device',
			passthrough: {
				req: permissions.root,
			},
			options: {
				$select: ['uuid'],
				$filter: {
					$not: {
						belongs_to__application: {
							$in: appIds,
						},
					},
					is_running__release: {
						$any: {
							$alias: 'r',
							$expr: {
								r: {
									belongs_to__application: {
										$in: appIds,
									},
								},
							},
						},
					},
				},
			},
		});
		if (devices.length !== 0) {
			const uuids = devices.map(({ uuid }) => uuid);
			throw new BadRequestError('updateRequired', {
				error: 'updateRequired',
				message: `Can't delete application(s) ${appIds.join(
					', ',
				)} because following devices are still running releases that belong to these application(s): ${uuids.join(
					', ',
				)}`,
				appids: appIds,
				uuids,
			});
		}
		// We need to null `should_be_running__release` or otherwise we have a circular dependency and cannot delete either
		await args.api.patch({
			resource: 'application',
			options: {
				$filter: {
					id: { $in: appIds },
					should_be_running__release: { $ne: null },
				},
			},
			body: { should_be_running__release: null },
		});
	},
});
