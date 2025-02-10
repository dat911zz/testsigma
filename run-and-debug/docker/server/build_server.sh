#!/bin/bash

# Set the root folder
ROOT_FOLDER=$(pwd)
CURRENT_DIR=$(pwd)

echo "[+] Build automator module"
cd $ROOT_FOLDER/automator
mvn -T 1C clean install || { echo "Build failed for automator"; exit 1; }

# Update application.properties for local agent download tag
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' -e "s/local.agent.download.tag=latest/local.agent.download.tag=$LOCAL_AGENT_TAG/g" $ROOT_FOLDER/server/src/main/resources/application.properties
else
  sed -i "s/local.agent.download.tag=latest/local.agent.download.tag=$LOCAL_AGENT_TAG/g" $ROOT_FOLDER/server/src/main/resources/application.properties
fi

# Build the server module
echo "[+] Build server module cd $ROOT_FOLDER/server"
cd $ROOT_FOLDER/server
mvn -T 1C install || { echo "Build failed for server"; exit 1; } 

# Revert application.properties changes
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' -e "s/local.agent.download.tag=$LOCAL_AGENT_TAG/local.agent.download.tag=latest/g" $ROOT_FOLDER/server/src/main/resources/application.properties
else
  sed -i "s/local.agent.download.tag=$LOCAL_AGENT_TAG/local.agent.download.tag=latest/g" $ROOT_FOLDER/server/src/main/resources/application.properties
fi

# Return to the initial directory
cd $CURRENT_DIR

echo "Copy files"
cp -f $ROOT_FOLDER/server/target/testsigma-server.jar /opt/app/

echo "Build completed successfully."
