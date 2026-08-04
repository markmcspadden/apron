export interface GrafanaDashboard {
  title: string;
  uid: string;
  panels: GrafanaPanel[];
}

interface GrafanaPanel {
  id: number;
  title: string;
  type: string;
  gridPos: { x: number; y: number; w: number; h: number };
  targets: Array<{ expr: string; legendFormat: string }>;
}

export const APRON_DASHBOARD: GrafanaDashboard = {
  title: 'Apron — Agent Crew Activity',
  uid: 'apron-crew-activity',
  panels: [
    {
      id: 1,
      title: 'Agent Events / minute',
      type: 'timeseries',
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
      targets: [
        {
          expr: 'rate(apron_agent_event[1m])',
          legendFormat: '{{agent}}',
        },
      ],
    },
    {
      id: 2,
      title: 'Crew at Risk',
      type: 'stat',
      gridPos: { x: 12, y: 0, w: 6, h: 4 },
      targets: [
        {
          expr: 'apron_crew_at_risk',
          legendFormat: '{{show_id}}',
        },
      ],
    },
    {
      id: 3,
      title: 'Call Times Exposed',
      type: 'stat',
      gridPos: { x: 18, y: 0, w: 6, h: 4 },
      targets: [
        {
          expr: 'apron_call_times_exposed',
          legendFormat: '{{show_id}}',
        },
      ],
    },
    {
      id: 4,
      title: 'Agent Processing Latency',
      type: 'timeseries',
      gridPos: { x: 12, y: 4, w: 12, h: 4 },
      targets: [
        {
          expr: 'apron_agent_process_duration_ms',
          legendFormat: '{{agent}}',
        },
      ],
    },
    {
      id: 5,
      title: 'Show State Changes',
      type: 'logs',
      gridPos: { x: 0, y: 8, w: 24, h: 6 },
      targets: [
        {
          expr: 'apron_show_state_change',
          legendFormat: '{{show_id}} → {{state}}',
        },
      ],
    },
  ],
};

export async function createDashboard(
  grafanaUrl: string,
  apiKey: string,
  dashboard?: GrafanaDashboard,
): Promise<{ uid: string; url: string }> {
  const db = dashboard ?? APRON_DASHBOARD;

  const res = await fetch(`${grafanaUrl}/api/dashboards/db`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      dashboard: db,
      overwrite: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create dashboard: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { uid: string; url: string };
  return { uid: data.uid, url: `${grafanaUrl}${data.url}` };
}
