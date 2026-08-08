#!/bin/sh
set -eu

# The api container owns schema migrations. Running them here — rather than from Coolify's
# pre/post-deployment hooks — is what makes an automated deploy safe:
#
#   * pre_deployment_command execs into the *previous* image's containers, so it would apply
#     the old migration set and silently miss anything new in this release.
#   * post_deployment_command runs after the rolling update and swallows its own failures, so
#     a broken migration would leave the new code live on a stale schema with a green deploy.
#
# Migrating here means the schema is in place before this process accepts a single request, and
# a failed migration exits non-zero -> the container never becomes healthy -> Coolify fails the
# deployment and leaves the previous containers serving.
#
# This assumes a single api replica, which is the current topology. Running more than one would
# need an advisory lock around the migration step so replicas don't race.
/usr/local/bin/run-migrations

exec node --enable-source-maps ./dist/index.mjs
