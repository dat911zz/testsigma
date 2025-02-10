#!/bin/bash

set -x
echo "Build UI"
npx ng build --source-map --configuration=docker
echo "Build UI successfully!"