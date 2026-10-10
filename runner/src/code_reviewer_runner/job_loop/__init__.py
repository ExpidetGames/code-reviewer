"""The job loop: claims jobs from the app, runs one process per job, reports the outcome.

settings.py   what the operator configures (environment variables)
api.py        the HTTP client of the runner API (claim, heartbeat, complete)
process.py    one process per job: start, bounded output, end it with its children
reporting.py  turns what a process did into the result the app stores
masking.py    keeps secrets out of the runner's own log lines
loop.py       the loop itself (slots, heartbeats, timeout, shutdown, back-off)
service.py    the real wiring: signals, logging, the event loop
"""
