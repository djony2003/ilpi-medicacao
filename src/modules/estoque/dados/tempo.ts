import type { PoolClient } from "pg";

/** "Agora" no fuso da casa: a data de calendário e os minutos desde a meia-noite. */
export async function agoraNaCasa(
  c: PoolClient,
  agora: Date,
): Promise<{ hoje: string; minutos: number }> {
  const r = await c.query<{ hoje: string; minutos: number }>(
    `SELECT (l::date)::text AS hoje,
            (extract(hour FROM l) * 60 + extract(minute FROM l))::int AS minutos
       FROM (SELECT $1::timestamptz AT TIME ZONE fuso_horario AS l
               FROM casa WHERE id = app_casa_id()) t`,
    [agora],
  );
  const l = r.rows[0];
  if (!l) return { hoje: agora.toISOString().slice(0, 10), minutos: 0 };
  return l;
}
