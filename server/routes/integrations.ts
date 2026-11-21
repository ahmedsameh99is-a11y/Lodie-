import { Router } from 'express';
import type { IntegrationConnector } from '../../src/shared/types';
import { db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth } from '../middleware';

export const integrationsRouter = Router();

integrationsRouter.use(requireAuth);

const CONNECTOR_CATALOG: Array<Omit<IntegrationConnector, 'status' | 'statusDetail' | 'connectedAccountLabel'>> = [
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'Cloud Documents',
    description: 'Read-only access to Google Docs, Sheets, and project folders via OAuth 2.0.',
    permissions: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Email & Triage',
    description: 'Read-only thread retrieval and draft preparation with explicit send confirmation.',
    permissions: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'Scheduling',
    description: 'Inspect upcoming schedule slots and meeting agendas securely.',
    permissions: ['https://www.googleapis.com/auth/calendar.readonly'],
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Source Control',
    description: 'Repository metadata, issue context, and pull-request review triggers.',
    permissions: ['repo:status', 'read:user'],
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Knowledge Base',
    description: 'Sync workspace pages into LOODY project reference contexts.',
    permissions: ['read_content'],
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Team Messaging',
    description: 'Channel thread summaries and approval-gated outbound notifications.',
    permissions: ['channels:read', 'chat:write (requires confirmation)'],
  },
];

function isOAuthConfiguredFor(id: string): { ready: boolean; envHint: string } {
  if (id === 'google-drive' || id === 'gmail' || id === 'google-calendar') {
    return {
      ready: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      envHint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
    };
  }
  if (id === 'github') {
    return {
      ready: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      envHint: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET',
    };
  }
  if (id === 'slack') {
    return {
      ready: Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
      envHint: 'SLACK_CLIENT_ID / SLACK_CLIENT_SECRET',
    };
  }
  if (id === 'notion') {
    return {
      ready: Boolean(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET),
      envHint: 'NOTION_CLIENT_ID / NOTION_CLIENT_SECRET',
    };
  }
  return { ready: false, envHint: 'OAUTH_CREDENTIALS' };
}

integrationsRouter.get('/', (req: AuthenticatedRequest, res) => {
  const userRows = db
    .prepare('SELECT * FROM user_integrations WHERE user_id = ?')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  const byConnector = new Map(userRows.map((r) => [String(r.connector_id), r]));

  const connectors: IntegrationConnector[] = CONNECTOR_CATALOG.map((item) => {
    const saved = byConnector.get(item.id);
    const { ready, envHint } = isOAuthConfiguredFor(item.id);
    if (saved && saved.status === 'connected' && ready) {
      return {
        ...item,
        status: 'connected',
        statusDetail: 'OAuth connection active and verified.',
        connectedAccountLabel: saved.account_label ? String(saved.account_label) : 'Connected Account',
      };
    }
    return {
      ...item,
      status: 'awaiting_config',
      statusDetail: ready
        ? 'OAuth provider ready — click Connect to authorize your account.'
        : `Awaiting OAuth client credentials (${envHint}).`,
      connectedAccountLabel: null,
    };
  });

  res.json({ connectors });
});

integrationsRouter.post('/:id/connect', (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id);
  const item = CONNECTOR_CATALOG.find((c) => c.id === id);
  if (!item) {
    res.status(404).json({ error: 'Unknown integration connector.' });
    return;
  }
  const { ready, envHint } = isOAuthConfiguredFor(id);
  if (!ready) {
    res.status(501).json({
      error: `${item.name} requires ${envHint} to be configured before OAuth authorization can proceed.`,
      status: 'awaiting_config',
    });
    return;
  }
  res.json({
    ok: true,
    redirectUrl: `/api/auth/${id}/start`,
  });
});

integrationsRouter.post('/:id/disconnect', (req: AuthenticatedRequest, res) => {
  db.prepare('DELETE FROM user_integrations WHERE user_id = ? AND connector_id = ?').run(
    req.authUser!.id,
    req.params.id
  );
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'integration_disconnected',
    targetType: 'integration',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: 'Disconnected integration credentials',
  });
  res.json({ ok: true });
});
