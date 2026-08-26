-- ============================================================================
-- Widestrides — Supabase schema
-- Paste this whole file into  Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.
-- ============================================================================

-- 1) MEMBERS -----------------------------------------------------------------
-- A user only becomes a "member" (gets to use the app) after redeeming a valid
-- invite code. is_admin = you, the owner, who can create invite codes.
create table if not exists public.members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;

drop policy if exists "read own membership" on public.members;
create policy "read own membership"
  on public.members for select
  using (auth.uid() = user_id);

-- 2) INVITE CODES ------------------------------------------------------------
create table if not exists public.invite_codes (
  code       text primary key,
  note       text,
  disabled   boolean not null default false,
  used_by    uuid references auth.users(id),
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;

-- Only admins can see / create / disable codes.
drop policy if exists "admin manage codes" on public.invite_codes;
create policy "admin manage codes"
  on public.invite_codes for all
  using      (exists (select 1 from public.members m where m.user_id = auth.uid() and m.is_admin))
  with check (exists (select 1 from public.members m where m.user_id = auth.uid() and m.is_admin));

-- 3) PER-USER DATA (profile + plan stored as one JSON blob) ------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4) REDEEM FUNCTION ---------------------------------------------------------
-- Atomically: claim an unused, enabled code and grant membership.
-- SECURITY DEFINER lets it write invite_codes/members even though the caller
-- is not yet an admin/member.
create or replace function public.redeem_invite(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Already a member? nothing to do.
  if exists (select 1 from public.members where user_id = auth.uid()) then
    return 'ok';
  end if;

  update public.invite_codes
     set used_by = auth.uid(), used_at = now()
   where code = p_code
     and disabled = false
     and used_by is null;

  if not found then
    return 'invalid';
  end if;

  insert into public.members (user_id, email)
  values (auth.uid(), auth.email())
  on conflict (user_id) do nothing;

  return 'ok';
end;
$$;

grant execute on function public.redeem_invite(text) to authenticated;

-- ============================================================================
-- 5) MAKE YOURSELF ADMIN  ← run this AFTER you have signed up once in the app.
--    Change the email if needed, then run just these lines again.
-- ============================================================================
-- insert into public.members (user_id, email, is_admin)
-- select id, email, true from auth.users where email = 'maek@basebangkok.com'
-- on conflict (user_id) do update set is_admin = true;
