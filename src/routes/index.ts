import type { Application } from 'express';

import {
	apiKeyMiddleware,
	authorized,
	gracefullyDenyDeletedDevices,
	identify,
	permissionRequired,
	registerDeviceStateEvent,
} from '../platform/middleware';

import { SECONDS_PER_HOUR } from '../lib/config';
import { createRateLimitMiddleware } from '../lib/rate-limiting';

// Rate limit for unauthenticated access
export const loginRateLimiter = createRateLimitMiddleware({
	points: 10, // 10 tries
	blockDuration: 1 * SECONDS_PER_HOUR, // wait 1 hour after 10 tries (in seconds)
	duration: 2 * SECONDS_PER_HOUR, // reset counter after 2 hours (in seconds)
});

// Rate limit for device log creation, a maximum of 15 batches every 10 second window
export const deviceLogsRateLimiter = createRateLimitMiddleware(
	{
		points: 14, // allow 15 device log batches (1+14 "retries") per window
		blockDuration: 10, // seconds
		duration: 10, // reset counter after 10 seconds (from the first batch of the window)
	},
	{
		ignoreIP: true,
	},
);

import type { SetupOptions } from '../index';
import * as access from '../routes/access';
import * as apiKeys from '../routes/api-keys';
import * as applications from '../routes/applications';
import * as auth from '../routes/auth';
import * as config from '../routes/config';
import * as deviceLogs from '../routes/device-logs';
import * as deviceTypes from '../routes/device-types';
import * as devices from '../routes/devices';
import * as os from '../routes/os';
import * as registry from '../routes/registry';
import * as services from '../routes/services';
import * as session from '../routes/session';

export const setup = (app: Application, onLogin: SetupOptions['onLogin']) => {
	app.get('/config/vars', config.vars);

	app.post(
		'/login_',
		loginRateLimiter('body.username'),
		session.login(onLogin),
	);
	app.get('/user/v1/whoami', authorized, session.whoami);

	app.post('/device/register', apiKeyMiddleware, devices.register);
	app.get(
		'/device/v2/:uuid/state',
		gracefullyDenyDeletedDevices,
		apiKeyMiddleware,
		registerDeviceStateEvent('params.uuid'),
		devices.state,
	);
	app.patch(
		'/device/v2/:uuid/state',
		gracefullyDenyDeletedDevices,
		apiKeyMiddleware,
		devices.statePatch,
	);
	app.get('/device/v2/:uuid/logs', authorized, deviceLogs.read);
	app.post(
		'/device/v2/:uuid/logs',
		deviceLogsRateLimiter('params.uuid'),
		apiKeyMiddleware,
		deviceLogs.store,
	);
	app.post(
		'/device/v2/:uuid/log-stream',
		apiKeyMiddleware,
		deviceLogs.storeStream,
	);
	app.post(
		'/dependent/v1/scan',
		apiKeyMiddleware,
		devices.receiveOnlineDependentDevices,
	);
	app.post(/^\/supervisor(\/.+)$/, apiKeyMiddleware, devices.proxy);

	app.get('/download-config', authorized, applications.downloadImageConfig);
	app.post('/download-config', authorized, applications.downloadImageConfig);

	// FIXME(refactor): this is legacy; move it out of here
	// this is deprecated and should be phased out - it's a user api key as well - the appId is irrelevant
	app.post(
		'/application/:appId/generate-api-key',
		authorized,
		apiKeys.createUserApiKey,
	);
	app.post(
		'/api-key/user/full',
		authorized,
		permissionRequired('auth.create_token'),
		apiKeys.createNamedUserApiKey,
	);
	app.post(
		'/api-key/application/:appId/provisioning',
		authorized,
		apiKeys.createProvisioningApiKey,
	);
	app.post(
		'/api-key/device/:deviceId/device-key',
		apiKeyMiddleware,
		apiKeys.createDeviceApiKey,
	);

	app.post('/api-key/v1', authorized, apiKeys.createGenericApiKey);

	app.get(
		'/services/vpn/auth/:device_uuid',
		apiKeyMiddleware,
		services.vpn.authDevice,
	);
	app.post(
		'/services/vpn/client-connect',
		apiKeyMiddleware,
		permissionRequired('service.vpn'),
		services.vpn.clientConnect,
	);
	app.post(
		'/services/vpn/client-disconnect',
		apiKeyMiddleware,
		permissionRequired('service.vpn'),
		services.vpn.clientDisconnect,
	);

	app.get('/auth/v1/token', registry.basicApiKeyAuthenticate, registry.token);

	app.get(
		'/auth/v1/public-keys/:username',
		apiKeyMiddleware,
		auth.getUserPublicKeys,
	);

	app.get('/access/v1/hostos/:device_uuid', authorized, access.hostOSAccess);

	app.get('/device-types/v1', identify, deviceTypes.getDeviceTypes);
	app.get('/device-types/v1/:deviceType', identify, deviceTypes.getDeviceType);
	app.get(
		'/device-types/v1/:deviceType/images',
		identify,
		deviceTypes.listAvailableImageVersions,
	);
	app.get(
		'/device-types/v1/:deviceType/images/:version/download-size',
		identify,
		deviceTypes.downloadImageSize,
	);

	app.get('/os/v1/config/', os.getOsConfiguration);
};
