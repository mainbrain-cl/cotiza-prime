-- H-012 · Cotiza Prime no usa GraphQL. Se quita la extensión pg_graphql para que no exista un
-- segundo camino de lectura (/graphql/v1) que haya que vigilar junto a la API REST.
drop extension if exists pg_graphql;
