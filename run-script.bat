@echo off

rem Change directory to the frontend directory
cd /ui

rem Start the Angular development server
set NODE_OPTIONS=--openssl-legacy-provider
npx ng serve

