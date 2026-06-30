#!/bin/sh
set -eu

exec ./node_modules/.bin/drizzle-kit migrate --config ./db/drizzle.config.ts
