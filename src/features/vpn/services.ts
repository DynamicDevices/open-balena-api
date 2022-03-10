import type { Request, Response } from 'express';

import * as _ from 'lodash';
import { sbvrUtils, permissions, errors } from '@balena/pinejs';
import {
	captureException,
	handleHttpErrors,
	translateError,
} from '../../infra/error-handling';
import { multiCacheMemoizee, reqPermissionNormalizer } from '../../infra/cache';
import { VPN_AUTH_CACHE_TIMEOUT } from '../../lib/config';

const { api } = sbvrUtils;

const checkAuth = (() => {
	const authQuery = _.once(() =>
		api.resin.prepare<{ uuid: string }>({
			resource: 'device',
			id: {
				uuid: { '@': 'uuid' },
			},
			options: {
				$select: 'id',
			},
		}),
	);
	return multiCacheMemoizee(
		async (uuid: string, req: permissions.PermissionReq): Promise<number> => {
			try {
				const device = await authQuery()({ uuid }, undefined, { req });
				// for now if the api key is able to read the device then it has vpn access
				return device != null ? 200 : 403;
			} catch (err) {
				if (err instanceof errors.UnauthorizedError) {
					// We handle `UnauthorizedError` specially so that we can cache it as it's a relatively
					// common case for devices that have been deleted but are still online/trying to connect
					return 401;
				}
				throw err;
			}
		},
		{
			cacheKey: 'checkAuth',
			promise: true,
			primitive: true,
			maxAge: VPN_AUTH_CACHE_TIMEOUT,
			normalizer: ([uuid, req]) => {
				return `${uuid}$${reqPermissionNormalizer(req)}`;
			},
		},
	);
})();

export const authDevice = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const statusCode = await checkAuth(req.params.device_uuid, req);
		res.status(statusCode).end();
	} catch (err) {
		if (handleHttpErrors(req, res, err)) {
			return;
		}
		captureException(err, 'Error authenticating device for VPN', { req });
		res.status(500).send(translateError(err));
	}
};
export const clientConnect = async (
	req: Request,
	res: Response,
): Promise<void> => {
	const { uuids, serviceId } = req.body || {};
	if (!uuids || uuids.length === 0 || !serviceId) {
		res.status(400).end();
		return;
	}

	try {
		await api.resin.patch({
			resource: 'device',
			passthrough: {
				req,
			},
			options: {
				$filter: {
					uuid: { $in: uuids },
				},
			},
			body: {
				is_connected_to_vpn: true,
				is_managed_by__service_instance: serviceId,
			},
		});
		res.status(200).end();
	} catch (err) {
		captureException(err, 'Error with vpn client connect', { req });
		if (handleHttpErrors(req, res, err)) {
			return;
		}
		res.status(500).send(translateError(err));
	}
};

export const clientDisconnect = async (
	req: Request,
	res: Response,
): Promise<void> => {
	const { uuids, serviceId } = req.body || {};
	if (!uuids || uuids.length === 0 || !serviceId) {
		res.status(400).end();
		return;
	}

	try {
		await api.resin.patch({
			resource: 'device',
			passthrough: { req },
			options: {
				$filter: {
					uuid: { $in: uuids },
					// Only disconnect if still managed by this vpn
					is_managed_by__service_instance: serviceId,
				},
			},
			body: {
				is_connected_to_vpn: false,
			},
		});
		res.status(200).end();
	} catch (err) {
		captureException(err, 'Error with vpn client disconnect', { req });
		if (handleHttpErrors(req, res, err)) {
			return;
		}
		res.status(500).send(translateError(err));
	}
};
