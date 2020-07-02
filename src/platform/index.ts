import * as _ from 'lodash';

import { sbvrUtils, permissions } from '@balena/pinejs';
import type { FilterObj } from 'pinejs-client-core';

import { captureException } from './errors';

if (sbvrUtils.db.readTransaction == null) {
	throw new Error('`readTransaction` is unsupported');
}

// TODO: Potential races here. They are unlikely but not impossible. Will fix
// in subsequent PR.
const $getOrInsertId = async (
	api: sbvrUtils.PinejsClient,
	resource: string,
	body: AnyObject,
	tx?: Tx,
): Promise<{ id: number }> => {
	const apiTx = api.clone({ passthrough: { req: permissions.root, tx } });
	const results = (await apiTx.get({
		resource,
		options: {
			$select: 'id',
			$filter: body,
		},
	})) as Array<{ id: number }>;
	if (results.length === 0) {
		const idObj = (await apiTx.post({
			resource,
			body,
			options: { returnResource: false },
		})) as { id: number };
		return { ...idObj, ...body };
	} else {
		return results[0];
	}
};

// Given a filter, if a resource exists which supports said filter,
// update it to the values specified in updateFields, otherwise
// insert it with a combination of the filter and updateFields value
const $updateOrInsert = async (
	api: sbvrUtils.PinejsClient,
	resource: string,
	filter: FilterObj,
	updateFields: AnyObject,
	tx?: Tx,
): Promise<{ id: number }> => {
	const apiTx = api.clone({ passthrough: { req: permissions.root, tx } });
	const results = (await apiTx.get({
		resource,
		options: {
			$filter: filter,
			$select: ['id'],
		},
	})) as Array<{ id: number }>;

	if (results.length === 0) {
		const body = _.cloneDeep(filter);
		_.merge(body, updateFields);
		return apiTx.post({
			resource,
			body,
			options: { returnResource: false },
		}) as Promise<{ id: number }>;
	} else if (results.length > 1) {
		throw new Error(
			`updateOrInsert filter not unique for '${resource}': '${JSON.stringify(
				filter,
			)}'`,
		);
	} else {
		// do a patch with the id
		await apiTx.patch({
			resource,
			id: results[0].id,
			options: {
				$filter: { $not: updateFields },
			},
			body: updateFields,
		});
		return results[0];
	}
};

export const getOrInsertId = (
	resource: string,
	body: AnyObject,
	tx?: Tx,
): Promise<{ id: number }> =>
	$getOrInsertId(sbvrUtils.api.Auth, resource, body, tx);
export const getOrInsertModelId = (
	resource: string,
	body: AnyObject,
	tx?: Tx,
): Promise<{ id: number }> =>
	$getOrInsertId(sbvrUtils.api.resin, resource, body, tx);

export const updateOrInsert = (
	resource: string,
	filter: FilterObj,
	updateFields: AnyObject,
	tx?: Tx,
): Promise<{ id: number }> =>
	$updateOrInsert(sbvrUtils.api.Auth, resource, filter, updateFields, tx);
export const updateOrInsertModel = (
	resource: string,
	filter: FilterObj,
	updateFields: AnyObject,
	tx?: Tx,
): Promise<{ id: number }> =>
	$updateOrInsert(sbvrUtils.api.resin, resource, filter, updateFields, tx);

// Hook helpers

export const createActor = async ({
	request,
	tx,
}: sbvrUtils.HookArgs): Promise<void> => {
	const result = (await sbvrUtils.api.Auth.post({
		resource: 'actor',
		passthrough: {
			tx,
			req: permissions.root,
		},
		options: { returnResource: false },
	})) as AnyObject;
	request.values.actor = result.id;
};

export function addDeleteHookForDependents(
	resource: string,
	dependents: Array<[string, string]>,
) {
	sbvrUtils.addPureHook('DELETE', 'resin', resource, {
		PRERUN: async (args) => {
			const { api, req } = args;

			const resourceIds = await sbvrUtils.getAffectedIds(args);
			if (resourceIds.length === 0) {
				return;
			}

			for (const [dependent, resourceIdField] of dependents) {
				try {
					await api.delete({
						resource: dependent,
						options: {
							$filter: {
								[resourceIdField]: { $in: resourceIds },
							},
						},
					});
				} catch (err) {
					captureException(
						err,
						`Error deleting resource '${dependent}' before deleting '${resource}' `,
						{
							req,
						},
					);
					throw err;
				}
			}
		},
	});
}
