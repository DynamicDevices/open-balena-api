import type { RequestHandler } from 'express';
import { checkSudoValidity } from './jwt';

import { prefetchAPIKey, retrieveAPIKey } from './api-keys';
import { getUser, reqHasPermission } from './auth';

export const authenticatedMiddleware: RequestHandler = async (
	req,
	res,
	next,
) => {
	try {
		await getUser(req, undefined, false);
		if (req.creds) {
			next();
			return null;
		} else {
			res.status(401).end();
		}
	} catch {
		res.status(401).end();
	}
};

export const authorizedMiddleware: RequestHandler = async (req, res, next) => {
	try {
		await getUser(req, undefined);
		next();
		return null;
	} catch {
		res.status(401).end();
	}
};

export const identifyMiddleware: RequestHandler = async (req, _res, next) => {
	await getUser(req, undefined, false);
	next();
	return null;
};

export const prefetchApiKeyMiddleware: RequestHandler = (req, _res, next) => {
	prefetchAPIKey(req, undefined);
	next();
};

export const apiKeyMiddleware: RequestHandler = async (req, _res, next) => {
	try {
		// Note: this won't reply with 401 if there's no api key
		await retrieveAPIKey(req, undefined);
		next();
	} catch (err) {
		next(err);
	}
};

export const permissionRequiredMiddleware =
	(permission: string): RequestHandler =>
	(req, res, next) => {
		if (reqHasPermission(req, permission)) {
			next();
			return null;
		} else {
			res.status(401).end();
		}
	};

export const sudoMiddleware: RequestHandler = async (req, res, next) => {
	try {
		const user = await getUser(req, undefined, false);
		if (user != null && (await checkSudoValidity(user))) {
			next();
			return;
		} else {
			res.status(401).json({ error: 'Fresh authentication token required' });
		}
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
};
