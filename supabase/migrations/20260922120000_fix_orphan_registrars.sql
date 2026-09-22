-- Re-home registrars the scheduled updater created without an owner
--
-- set_user_id_on_registrars() overwrote user_id with auth.uid(), which is null for the
-- service role, so every registrar row domain-updater inserted was hidden from its owner
-- by RLS, and the unscoped name lookup kept adding duplicates. The trigger now keeps a
-- supplied user_id (the insert policy still enforces ownership for users), each affected
-- domain is pointed at a registrar owned by its user, and unreferenced orphans are removed.

create or replace function public.set_user_id_on_registrars()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  new.user_id := coalesce(new.user_id, auth.uid());
  return new;
end;
$$;

-- Give each user an owned copy of every in-use orphan they have no registrar for yet
insert into public.registrars (name, url, user_id)
select distinct on (d.user_id, lower(r.name)) r.name, r.url, d.user_id
from public.domains d
join public.registrars r on r.id = d.registrar_id
where r.user_id is null
  and not exists (
    select 1 from public.registrars o
    where o.user_id = d.user_id and lower(o.name) = lower(r.name)
  )
order by d.user_id, lower(r.name), (r.url is null), r.id;

-- Point every affected domain at its owner's registrar of the same name
with mapping as (
  select distinct on (d.id) d.id as domain_id, o.id as registrar_id
  from public.domains d
  join public.registrars r on r.id = d.registrar_id
  join public.registrars o
    on o.user_id = d.user_id and lower(o.name) = lower(r.name)
  where r.user_id is null
  order by d.id, o.id
)
update public.domains d
set registrar_id = m.registrar_id
from mapping m
where d.id = m.domain_id;

-- Drop the orphans, keeping any row a domain still references
delete from public.registrars r
where r.user_id is null
  and not exists (select 1 from public.domains d where d.registrar_id = r.id);
