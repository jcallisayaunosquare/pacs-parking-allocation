# Vehicles — requests for files owned elsewhere

The vehicle register (plate, make, model, year, colour, photo keys) is built end to end:
migration, domain, use cases, Kysely repository, routes, OpenAPI, and the Angular data
and application rings. The administrator surface is reachable now, from the **Vehicles**
item in each row's action menu on `/admin/residents` — no routing change was needed, so
`app.routes.ts` was not touched.

Two things the API already supports and the UI does not yet expose. Both land in files
another worker owns right now, so they are written here rather than edited.

## 1. A resident managing their own vehicles

`GET/POST /residents/{id}/vehicles` and the `PATCH`/`DELETE` beside them accept a
**resident** token as well as an administrator one. The server scopes them from the
token: a resident may only reach their own record, and reaching for another one answers
404 rather than 403, so the route cannot be used to enumerate residents.

Nothing in the resident surface calls them. The natural place is the resident dashboard —
`features/dashboard/**` — as a short list of the plates on file with an "Add a vehicle"
action, next to where the bay is shown. Everything it needs exists:

- `VehicleRepository` (`domain/repositories.ts`), bound in `app.config.ts`
- `VehiclesFacade` (`application/admin.facades.ts`) — provide it on the component, not in
  root: its state is one resident's vehicles and it must not outlive the view
- `VehiclesDialog` (`features/admin/residents-dialogs.ts`) is admin-shaped (it takes a
  `Resident` and prints the unit number); a resident-facing version should be its own
  component rather than a conditional inside that one

## 2. The plate a bay is occupied by, on the lot map

`GET /vehicles/by-plate/{plate}` (administrator only) resolves a plate read off a camera
to its vehicle and the resident who registered it. Showing the registered plates of the
resident holding a bay, in the bay's detail panel, would close the loop between the map
and the gate — `shared/ui/lot-map.ts` and `features/lot/**` are owned elsewhere, so it is
left as a request.

## Not built, deliberately

**Photo upload.** `photos` is a `jsonb` array of object keys or URLs and the API stores
the strings it is given; it hosts nothing and resizes nothing. The intended follow-up is
an S3 presigned `PUT` per photo with the key written back here once the client reports the
upload finished. The dialog says so in its hint rather than offering a file picker that
would silently drop the file.
