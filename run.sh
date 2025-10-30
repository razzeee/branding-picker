#!/usr/bin/env sh
# Prefer Adwaita theme when running locally
export GTK_THEME=Adwaita
exec gjs dist/main.js "$@"
