import { hooks, permissions } from '@balena/pinejs';
import { getApplicationSlug } from '..';
import { Application, Organization } from '../../../balena-model';

hooks.addPureHook('POST', 'resin', 'application', {
	POSTPARSE: ({ request }) => {
		// Make sure the slug is included in the PATCH and fetch/set the true value in the POSTRUN
		// where we will definitely have the db transaction available
		request.values.slug ??= '';
	},
	PRERUN: async ({ request, api }) => {
		if (request.values.belongs_to__organization != null) {
			const organization = (await api.get({
				resource: 'organization',
				id: request.values.belongs_to__organization,
				options: {
					$select: 'handle',
				},
			})) as Pick<Organization, 'handle'> | undefined;
			if (organization) {
				request.values.slug = getApplicationSlug(
					organization.handle,
					request.values.name,
				);
			}
		}
	},
});

hooks.addPureHook('PATCH', 'resin', 'application', {
	POSTRUN: async (args) => {
		const { request, api, tx } = args;
		const ids = request.affectedIds!;
		if (ids.length === 0) {
			return;
		}
		if (
			request.values.belongs_to__organization != null ||
			request.values.name != null
		) {
			// If the owner of the app or the application name is changed, then update
			// the app's `slug`.

			// We do the actual update as root because it's a system
			// generated field and cannot be modified directly by the user
			const rootApi = api.clone({
				passthrough: { tx, req: permissions.root },
			});

			const apps = await rootApi.get({
				resource: 'application',
				options: {
					$select: ['id', 'name'],
					$expand: {
						belongs_to__organization: {
							$select: ['handle'],
						},
					},
					$filter: {
						id: { $in: ids },
					},
				},
			});

			await Promise.all(
				apps.map((app) =>
					rootApi.patch({
						resource: 'application',
						id: app.id,
						body: {
							slug: getApplicationSlug(app.organization[0].handle, app.name),
						},
					}),
				),
			);
		}
	},
});

hooks.addPureHook('PATCH', 'resin', 'organization', {
	POSTRUN: async (args) => {
		const { request, api, tx } = args;
		const orgIds = request.affectedIds!;
		if (orgIds.length === 0) {
			return;
		}

		if (request.values.handle != null) {
			await Promise.all(
				orgIds.map(async (organizationID) => {
					const apps = (await api.get({
						resource: 'application',
						options: {
							$filter: {
								organization: organizationID,
							},
							$select: ['id', 'name'],
						},
					})) as Array<Pick<Application, 'id' | 'name'>>;

					const rootApiTx = api.clone({
						passthrough: {
							req: permissions.root,
							tx,
						},
					});

					await Promise.all(
						apps.map(({ id, name }) =>
							rootApiTx.patch({
								resource: 'application',
								id,
								body: {
									slug: getApplicationSlug(request.values.handle, name),
								},
							}),
						),
					);
				}),
			);
		}
	},
});
