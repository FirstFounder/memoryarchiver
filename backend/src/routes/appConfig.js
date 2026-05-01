import config from '../config.js';

export default async function appConfigRoute(fastify) {
  fastify.get('/api/config', async (_req, reply) => {
    return reply.send({
      deviceRole:      config.deviceRole,
      nasOutputRoot:   config.nasOutputRoot,
      syncDestRoot:    config.syncDestRoot,
      pushTargets:     config.pushTargets,
      nfsDestinations: config.nfsDestinations,
      coopEnabled:     config.coopEnabled,
      teslaEnabled:    config.teslaEnabled,
      caEnabled:       config.caEnabled,
      hubUrl:          config.hubUrl,
      squatEnabled:    config.squatEnabled,
      squatHost:       config.squatHost,
      squatPort:       config.squatPort,
      squatQuality:    config.squatQuality,
    });
  });
}
