import fs from "node:fs";
import path from "node:path";
import pg from "pg";

type Command =
  | "users:add"
  | "users:remove"
  | "race:add"
  | "race:remove"
  | "unlimited:add"
  | "unlimited:remove";

type Args = {
  command: Command;
  raceId?: string;
  count: number;
  batch: string;
  forceTerminal: boolean;
};

const DEFAULT_COUNT = 100;
const DEFAULT_BATCH = "default";
const USER_ID_PREFIX = "wc_dummy";
const EMAIL_DOMAIN = "walkchamp.test";

function usage(): never {
  console.error(`
Usage:
  tsx scripts/src/dummyData.ts users:add [--count 100] [--batch smoke]
  tsx scripts/src/dummyData.ts users:remove --batch smoke
  tsx scripts/src/dummyData.ts race:add --race-id <uuid> [--count 100] [--batch smoke] [--force-terminal]
  tsx scripts/src/dummyData.ts race:remove --race-id <uuid> [--batch smoke]
  tsx scripts/src/dummyData.ts unlimited:add --race-id <id> [--count 100] [--batch smoke]
  tsx scripts/src/dummyData.ts unlimited:remove --race-id <id> [--batch smoke]

Notes:
  - Dummy profile ids are prefixed with ${USER_ID_PREFIX}_<batch>_.
  - users:remove only deletes dummy users that are not referenced by race_participants.
  - race:add refuses completed/cancelled/expired rooms unless --force-terminal is passed.
`);
  process.exit(1);
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return normalized || DEFAULT_BATCH;
}

function parseArgs(argv: string[]): Args {
  const command = argv[2] as Command | undefined;
  if (!command || !["users:add", "users:remove", "race:add", "race:remove", "unlimited:add", "unlimited:remove"].includes(command)) usage();

  const args: Args = {
    command,
    count: DEFAULT_COUNT,
    batch: DEFAULT_BATCH,
    forceTerminal: false,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--count" && next) {
      args.count = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--batch" && next) {
      args.batch = slug(next);
      i += 1;
    } else if (arg === "--race-id" && next) {
      args.raceId = next.trim();
      i += 1;
    } else if (arg === "--force-terminal") {
      args.forceTerminal = true;
    } else {
      usage();
    }
  }

  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 10000) {
    throw new Error("--count must be an integer from 1 to 10000.");
  }
  if ((command === "race:add" || command === "race:remove" || command === "unlimited:add" || command === "unlimited:remove") && !args.raceId) {
    throw new Error("--race-id is required for race/unlimited commands.");
  }
  if ((command === "users:remove" || command === "race:remove" || command === "unlimited:remove") && args.batch === DEFAULT_BATCH) {
    throw new Error("Refusing to remove the default batch. Pass an explicit --batch.");
  }

  return args;
}

function loadDotEnv(): Record<string, string> {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return {};

  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function databaseUrl(): string {
  const fileEnv = loadDotEnv();
  const value =
    process.env.DATABASE_ADMIN_URL
    ?? process.env.NEON_DATABASE_ADMIN_URL
    ?? process.env.DATABASE_RUNTIME_URL
    ?? process.env.NEON_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? fileEnv.DATABASE_ADMIN_URL
    ?? fileEnv.NEON_DATABASE_ADMIN_URL
    ?? fileEnv.DATABASE_RUNTIME_URL
    ?? fileEnv.NEON_DATABASE_URL
    ?? fileEnv.DATABASE_URL;

  if (!value) {
    throw new Error("DATABASE_ADMIN_URL, NEON_DATABASE_ADMIN_URL, DATABASE_RUNTIME_URL, NEON_DATABASE_URL, or DATABASE_URL must be set.");
  }
  return value;
}

function userPrefix(batch: string): string {
  return `${USER_ID_PREFIX}_${batch}_`;
}

function userIdExpr(batch: string) {
  return `${userPrefix(batch)}%`;
}

async function ensureDummyUsers(client: pg.Client, batch: string, count: number) {
  await client.query(
    `
    insert into profiles (
      id,
      email,
      full_name,
      username,
      auth_provider,
      email_verified,
      terms_accepted,
      privacy_accepted,
      reward_disclaimer_accepted,
      fair_play_accepted,
      is_adult,
      account_status,
      avatar_color,
      profile_completed,
      created_at,
      updated_at
    )
    select
      $1 || lpad(n::text, 5, '0'),
      'dummy+' || $2 || '+' || lpad(n::text, 5, '0') || '@${EMAIL_DOMAIN}',
      'Dummy User ' || lpad(n::text, 5, '0'),
      'du' || substr(md5($2 || ':' || n::text), 1, 12),
      'dummy_seed',
      true,
      true,
      true,
      true,
      true,
      true,
      'active',
      '#' || substr(md5('color:' || $2 || ':' || n::text), 1, 6),
      true,
      now(),
      now()
    from generate_series(1, $3::int) as n
    on conflict (id) do update set
      email_verified = true,
      terms_accepted = true,
      privacy_accepted = true,
      reward_disclaimer_accepted = true,
      fair_play_accepted = true,
      is_adult = true,
      account_status = 'active',
      profile_completed = true,
      updated_at = now()
    `,
    [userPrefix(batch), batch, count],
  );
}

async function addUsers(client: pg.Client, args: Args) {
  await client.query("begin");
  try {
    await ensureDummyUsers(client, args.batch, args.count);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }

  const result = await client.query(
    `
    select count(*)::int as count
    from profiles
    where id like $1
    `,
    [userIdExpr(args.batch)],
  );
  console.log(`dummy_users=${result.rows[0].count} batch=${args.batch}`);
}

async function removeUsers(client: pg.Client, args: Args) {
  await client.query("begin");
  try {
    const deleted = await client.query(
      `
      delete from profiles p
      where p.id like $1
        and p.auth_provider = 'dummy_seed'
        and not exists (
          select 1 from race_participants rp where rp.user_id = p.id
        )
        and not exists (
          select 1 from scheduled_room_registrations srr where srr.user_id = p.id
        )
        and not exists (
          select 1 from unlimited_challenge_participants ucp where ucp.user_id = p.id
        )
      returning p.id
      `,
      [userIdExpr(args.batch)],
    );
    await client.query("commit");
    console.log(`deleted_dummy_users=${deleted.rowCount ?? 0} batch=${args.batch}`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function addRaceParticipants(client: pg.Client, args: Args) {
  await client.query("begin");
  try {
    const roomResult = await client.query(
      `
      select id, status, schedule_type, mode, current_players, registered_count, max_players
      from race_rooms
      where id = $1
      for update
      `,
      [args.raceId],
    );
    const room = roomResult.rows[0];
    if (!room) throw new Error(`Race room not found: ${args.raceId}`);
    if (!args.forceTerminal && ["completed", "cancelled", "expired"].includes(room.status)) {
      throw new Error(`Race room is ${room.status}. Re-run with --force-terminal only if you intentionally want dummy rows on a terminal race.`);
    }

    await ensureDummyUsers(client, args.batch, args.count);

    const insertedParticipants = room.status === "scheduled"
      ? { rowCount: 0 }
      : await client.query(
          `
          insert into race_participants (
            race_room_id,
            user_id,
            status,
            current_steps,
            race_baseline_steps,
            latest_device_steps,
            live_source,
            reconciliation_status,
            joined_at
          )
          select
            $1::uuid,
            p.id,
            case when $4 = 'in_progress' then 'active'::participant_status else 'joined'::participant_status end,
            0,
            0,
            0,
            'simulation'::live_step_source,
            'pending'::reconciliation_status,
            now()
          from profiles p
          where p.id like $2
          order by p.id
          limit $3::int
          on conflict do nothing
          returning user_id
          `,
          [args.raceId, userIdExpr(args.batch), args.count, room.status],
        );

    let insertedRegistrations = { rowCount: 0 };
    if (room.status === "scheduled") {
      insertedRegistrations = await client.query(
        `
        insert into scheduled_room_registrations (race_room_id, user_id, status, registered_at)
        select $1::uuid, p.id, 'registered', now()
        from profiles p
        where p.id like $2
        order by p.id
        limit $3::int
        on conflict do nothing
        `,
        [args.raceId, userIdExpr(args.batch), args.count],
      );
    }

    const counts = await client.query(
      `
      select
        count(*) filter (where rp.status <> 'left')::int as participant_count,
        (
          select count(*)::int
          from scheduled_room_registrations srr
          where srr.race_room_id = $1
            and srr.status = 'registered'
        ) as registered_count
      from race_participants rp
      where rp.race_room_id = $1
      `,
      [args.raceId],
    );
    const participantCount = counts.rows[0].participant_count as number;
    const registeredCount = counts.rows[0].registered_count as number;
    const roomPlayerCount = room.status === "scheduled" ? Number(room.current_players) : participantCount;

    await client.query(
      `
      update race_rooms
      set current_players = $2,
          registered_count = case when status = 'scheduled' then $3 else registered_count end,
          max_players = greatest(max_players, case when status = 'scheduled' then $3 else $2 end),
          status = case
            when status in ('open', 'full') and $2 >= greatest(max_players, $2) then 'full'::race_status
            when status in ('open', 'full') then 'open'::race_status
            else status
          end,
          updated_at = now()
      where id = $1
      `,
      [args.raceId, roomPlayerCount, registeredCount],
    );

    await client.query("commit");
    console.log(
      `inserted_participants=${insertedParticipants.rowCount ?? 0} inserted_registrations=${insertedRegistrations.rowCount ?? 0} race_id=${args.raceId} batch=${args.batch}`,
    );
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function removeRaceParticipants(client: pg.Client, args: Args) {
  await client.query("begin");
  try {
    const roomResult = await client.query(
      "select id from race_rooms where id = $1 for update",
      [args.raceId],
    );
    if (!roomResult.rows[0]) throw new Error(`Race room not found: ${args.raceId}`);

    const regs = await client.query(
      `
      delete from scheduled_room_registrations srr
      where srr.race_room_id = $1
        and srr.user_id like $2
      returning srr.user_id
      `,
      [args.raceId, userIdExpr(args.batch)],
    );
    const participants = await client.query(
      `
      delete from race_participants rp
      where rp.race_room_id = $1
        and rp.user_id like $2
      returning rp.user_id
      `,
      [args.raceId, userIdExpr(args.batch)],
    );

    const counts = await client.query(
      `
      select
        count(*) filter (where rp.status <> 'left')::int as participant_count,
        (
          select count(*)::int
          from scheduled_room_registrations srr
          where srr.race_room_id = $1
            and srr.status = 'registered'
        ) as registered_count
      from race_participants rp
      where rp.race_room_id = $1
      `,
      [args.raceId],
    );
    const participantCount = counts.rows[0].participant_count as number;
    const registeredCount = counts.rows[0].registered_count as number;

    await client.query(
      `
      update race_rooms
      set current_players = $2,
          registered_count = case when status = 'scheduled' then $3 else registered_count end,
          status = case
            when status = 'full' and $2 < max_players then 'open'::race_status
            else status
          end,
          updated_at = now()
      where id = $1
      `,
      [args.raceId, participantCount, registeredCount],
    );

    await client.query("commit");
    console.log(
      `deleted_participants=${participants.rowCount ?? 0} deleted_registrations=${regs.rowCount ?? 0} race_id=${args.raceId} batch=${args.batch}`,
    );
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function addUnlimitedParticipants(client: pg.Client, args: Args) {
  await client.query("begin");
  try {
    const challengeResult = await client.query(
      `
      select id, status, entry_fee_cents, platform_fee_cents, prize_pool_cents, paid_participant_count
      from unlimited_challenges
      where id = $1
      for update
      `,
      [args.raceId],
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) throw new Error(`Unlimited challenge not found: ${args.raceId}`);
    if (!args.forceTerminal && !["waiting", "active"].includes(challenge.status)) {
      throw new Error(`Unlimited challenge is ${challenge.status}. Re-run with --force-terminal only if you intentionally want dummy rows on this status.`);
    }

    await ensureDummyUsers(client, args.batch, args.count);

    const inserted = await client.query(
      `
      insert into unlimited_challenge_participants (
        id,
        challenge_id,
        user_id,
        participant_timezone,
        qualification_status,
        entry_contribution_cents,
        platform_fee_cents,
        payment_reference,
        joined_at,
        created_at,
        updated_at
      )
      select
        gen_random_uuid()::text,
        $1,
        p.id,
        'UTC',
        'active',
        $4::int,
        $5::int,
        'dummy_unlimited_entry:' || $1 || ':' || p.id,
        now(),
        now(),
        now()
      from profiles p
      where p.id like $2
      order by p.id
      limit $3::int
      on conflict (challenge_id, user_id) do nothing
      returning user_id
      `,
      [args.raceId, userIdExpr(args.batch), args.count, challenge.entry_fee_cents, challenge.platform_fee_cents],
    );

    const counts = await client.query(
      `
      select
        count(*) filter (where qualification_status <> 'left')::int as participant_count,
        coalesce(sum(entry_contribution_cents) filter (where qualification_status <> 'left'), 0)::int as prize_pool_cents
      from unlimited_challenge_participants
      where challenge_id = $1
      `,
      [args.raceId],
    );

    await client.query(
      `
      update unlimited_challenges
      set paid_participant_count = $2,
          prize_pool_cents = $3,
          updated_at = now()
      where id = $1
      `,
      [args.raceId, counts.rows[0].participant_count, counts.rows[0].prize_pool_cents],
    );

    await client.query("commit");
    console.log(`inserted_unlimited_participants=${inserted.rowCount ?? 0} challenge_id=${args.raceId} batch=${args.batch}`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function removeUnlimitedParticipants(client: pg.Client, args: Args) {
  await client.query("begin");
  try {
    const challengeResult = await client.query(
      "select id from unlimited_challenges where id = $1 for update",
      [args.raceId],
    );
    if (!challengeResult.rows[0]) throw new Error(`Unlimited challenge not found: ${args.raceId}`);

    const deleted = await client.query(
      `
      delete from unlimited_challenge_participants ucp
      where ucp.challenge_id = $1
        and ucp.user_id like $2
        and ucp.payment_reference like 'dummy_unlimited_entry:%'
      returning ucp.user_id
      `,
      [args.raceId, userIdExpr(args.batch)],
    );

    const counts = await client.query(
      `
      select
        count(*) filter (where qualification_status <> 'left')::int as participant_count,
        coalesce(sum(entry_contribution_cents) filter (where qualification_status <> 'left'), 0)::int as prize_pool_cents
      from unlimited_challenge_participants
      where challenge_id = $1
      `,
      [args.raceId],
    );

    await client.query(
      `
      update unlimited_challenges
      set paid_participant_count = $2,
          prize_pool_cents = $3,
          updated_at = now()
      where id = $1
      `,
      [args.raceId, counts.rows[0].participant_count, counts.rows[0].prize_pool_cents],
    );

    await client.query("commit");
    console.log(`deleted_unlimited_participants=${deleted.rowCount ?? 0} challenge_id=${args.raceId} batch=${args.batch}`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    if (args.command === "users:add") await addUsers(client, args);
    if (args.command === "users:remove") await removeUsers(client, args);
    if (args.command === "race:add") await addRaceParticipants(client, args);
    if (args.command === "race:remove") await removeRaceParticipants(client, args);
    if (args.command === "unlimited:add") await addUnlimitedParticipants(client, args);
    if (args.command === "unlimited:remove") await removeUnlimitedParticipants(client, args);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
