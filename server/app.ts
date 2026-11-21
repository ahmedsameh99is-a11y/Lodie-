import express from 'express';
import { attachAuth } from './middleware';
import { agentsRouter } from './routes/agents';
import { authRouter } from './routes/auth';
import { billingRouter } from './routes/billing';
import { chatRouter, publicShareRouter } from './routes/chat';
import { creativeRouter } from './routes/creative';
import { filesRouter } from './routes/files';
import { integrationsRouter } from './routes/integrations';
import { koreRouter } from './routes/kore';
import { mcpRouter } from './routes/mcp';
import { memoriesRouter } from './routes/memories';
import { modelsRouter } from './routes/models';
import { projectsRouter } from './routes/projects';
import { researchRouter } from './routes/research';
import { settingsRouter } from './routes/settings';
import { skillsRouter } from './routes/skills';
import { tasksRouter } from './routes/tasks';

export const APP_VERSION = '2.6.0-phase3';

export function createApiApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '18mb' }));
  app.use(attachAuth);

  // Health & Version check
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'loody-workspace',
      version: APP_VERSION,
      stage: 'phase_3',
    });
  });

  // Mount versioned v1 APIs and /api aliases
  for (const prefix of ['/api/v1', '/api']) {
    app.use(`${prefix}/shares`, publicShareRouter);
    app.use(`${prefix}/auth`, authRouter);
    app.use(`${prefix}/models`, modelsRouter);
    app.use(`${prefix}/projects`, projectsRouter);
    app.use(`${prefix}/files`, filesRouter);
    app.use(`${prefix}/memories`, memoriesRouter);
    app.use(`${prefix}/mcp`, mcpRouter);
    app.use(`${prefix}/integrations`, integrationsRouter);
    app.use(`${prefix}/billing`, billingRouter);
    app.use(`${prefix}/settings`, settingsRouter);
    app.use(`${prefix}/agents`, agentsRouter);
    app.use(`${prefix}/skills`, skillsRouter);
    app.use(`${prefix}/tasks`, tasksRouter);
    app.use(`${prefix}/kore`, koreRouter);
    app.use(`${prefix}/research`, researchRouter);
    app.use(`${prefix}/creative`, creativeRouter);
    app.use(`${prefix}`, chatRouter);
  }

  // API 404 handler (prevent HTML fallback on unknown /api routes)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  return app;
}
