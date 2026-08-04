export const SCHEMA = {
  database: 'apron',
  tables: {
    audit_log: `
      CREATE TABLE IF NOT EXISTS apron.audit_log (
        sequence      UInt64,
        received_at   DateTime64(3),
        event_id      String,
        event_type    LowCardinality(String),
        show_id       LowCardinality(String),
        agent         LowCardinality(String),
        timestamp     DateTime64(3),
        message       String,
        payload       String
      )
      ENGINE = MergeTree()
      ORDER BY (show_id, sequence)
      TTL toDateTime(received_at) + INTERVAL 90 DAY
    `,
    agent_metrics: `
      CREATE TABLE IF NOT EXISTS apron.agent_metrics (
        timestamp     DateTime64(3),
        show_id       LowCardinality(String),
        agent         LowCardinality(String),
        metric_name   LowCardinality(String),
        value         Float64
      )
      ENGINE = MergeTree()
      ORDER BY (show_id, agent, timestamp)
      TTL toDateTime(timestamp) + INTERVAL 90 DAY
    `,
    show_events: `
      CREATE TABLE IF NOT EXISTS apron.show_events (
        timestamp     DateTime64(3),
        show_id       LowCardinality(String),
        event_type    LowCardinality(String),
        state         LowCardinality(String),
        crew_at_risk  UInt32,
        exposed       UInt32,
        detail        String
      )
      ENGINE = MergeTree()
      ORDER BY (show_id, timestamp)
      TTL toDateTime(timestamp) + INTERVAL 90 DAY
    `,
  },
} as const;
