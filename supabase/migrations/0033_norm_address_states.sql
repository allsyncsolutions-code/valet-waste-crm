-- 0033: norm_address now equates full state names with their USPS
-- abbreviations ("... Florida, 32092" == "... FL 32092"), so the duplicate
-- detector catches copies entered with the spelled-out state. No index
-- depends on this function, so CREATE OR REPLACE is safe to re-run.
create or replace function public.norm_address(a text)
returns text
language sql
immutable
as $function$
  with s0 as (select lower(coalesce(a, '')) as t),
  s1 as (select regexp_replace(t, '\m(united states of america|united states|usa|us)\M', ' ', 'g') as t from s0),
  s2 as (select regexp_replace(t, '[.,#]', ' ', 'g') as t from s1),
  -- multi-word state names first, as whole phrases
  s3 as (
    select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
             '\mnew hampshire\M','nh','g'),
             '\mnew jersey\M','nj','g'),
             '\mnew mexico\M','nm','g'),
             '\mnew york\M','ny','g'),
             '\mnorth carolina\M','nc','g'),
             '\mnorth dakota\M','nd','g'),
             '\mrhode island\M','ri','g'),
             '\msouth carolina\M','sc','g'),
             '\msouth dakota\M','sd','g'),
             '\mwest virginia\M','wv','g') as t
      from s2
  ),
  -- single-word substitutions, word by word: street types, directions,
  -- apartment, and the single-word state names
  s4 as (
    select (select string_agg(coalesce(m.abbr, u.w), ' ' order by u.ord)
            from unnest(string_to_array(t, ' ')) with ordinality as u(w, ord)
            left join (values
              ('street','st'),('saint','st'),('avenue','ave'),('drive','dr'),('road','rd'),
              ('boulevard','blvd'),('lane','ln'),('court','ct'),('circle','cir'),
              ('highway','hwy'),('place','pl'),('terrace','ter'),('parkway','pkwy'),
              ('north','n'),('south','s'),('east','e'),('west','w'),('apartment','apt'),
              ('alabama','al'),('alaska','ak'),('arizona','az'),('arkansas','ar'),
              ('california','ca'),('colorado','co'),('connecticut','ct'),('delaware','de'),
              ('florida','fl'),('georgia','ga'),('hawaii','hi'),('idaho','id'),
              ('illinois','il'),('indiana','in'),('iowa','ia'),('kansas','ks'),
              ('kentucky','ky'),('louisiana','la'),('maine','me'),('maryland','md'),
              ('massachusetts','ma'),('michigan','mi'),('minnesota','mn'),
              ('mississippi','ms'),('missouri','mo'),('montana','mt'),('nebraska','ne'),
              ('nevada','nv'),('ohio','oh'),('oklahoma','ok'),('oregon','or'),
              ('pennsylvania','pa'),('tennessee','tn'),('texas','tx'),('utah','ut'),
              ('vermont','vt'),('virginia','va'),('washington','wa'),('wisconsin','wi'),
              ('wyoming','wy')
            ) m(name, abbr) on m.name = u.w
    ) as t
    from s3
  )
  select nullif(trim(regexp_replace(t, '\s+', ' ', 'g')), '')
  from s4;
$function$;
