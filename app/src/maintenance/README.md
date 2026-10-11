# Maintenance

Housekeeping of tables that an outsider can make grow. `cleanup.ts` removes the counters of `rate_limits` whose
window is over (every window of the app is at most 24 hours, which `cleanup.integration.test.ts` pins against
each window constant, so a counter in force is never removed) and the verification links that expired or were
used more than a week ago (a week, so that someone who holds a link and its password is still told "used" or
"expired"). `startup.ts` runs it when the production server starts and then every hour, from
`src/instrumentation.ts`, like the backup timer (no timer in other environments); a failing run is logged by its
code and tried again at the next hour.
