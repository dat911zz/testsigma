#!/bin/sh

set -e  # Exit immediately if a command exits with a non-zero status

echo "Starting the build process..."

# Build jar
/opt/app/build_server.sh

echo "Running additional setup scripts..."

# Run other custom setup scripts
ROOT_FOLDER="$(
  cd "$(dirname "$0")" || exit
  pwd -P
)"

cd "$ROOT_FOLDER" || exit 1

OS_TYPE=${OSTYPE:-"unknown"}
OS_NAME=`uname`
MAIN_JAR_FILE="$ROOT_FOLDER/testsigma-server.jar"
LOGGING_LEVEL=INFO

if [[ "$OS_TYPE" == "darwin"* ]]; then
    export TS_DATA_DIR="$HOME/Library/Application Support/Testsigma/Server"
  elif [[ "$OS_TYPE" == "freebsd"* ]] || [[ "$OS_TYPE" == "linux-gnu" ]] || [[ "$OS_NAME" == "Linux" ]]; then
    export TS_DATA_DIR="$HOME/.testsigma/server"
  elif [[ "$OS_TYPE" == "cygwin"* ]] || [[ "$OS_TYPE" == "msys"* ]] || [[ "$OS_TYPE" == "win32"* ]]; then
    echo "Unsupported OS (Windows)"
    exit 1
  else
    echo "Unsupported OS"
    exit 1
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --TESTSIGMA_PLATFORM_URL=*)
      export TESTSIGMA_PLATFORM_URL="${1#*=}"
      ;;
    --TESTSIGMA_SERVER_URL=*)
      export TESTSIGMA_SERVER_URL="${1#*=}"
      ;;
    --TS_DATA_DIR=*)
      export TS_DATA_DIR="${1#*=}"
      ;;
    *)
      printf "***************************\n"
      printf "* Error: Invalid argument.*\n"
      printf "***************************\n"
      exit 1
  esac
  shift
done

if [[ "$OS_TYPE" == "darwin"* ]]; then
  xattr -r -d com.apple.quarantine ./
fi

mkdir -p "$TS_DATA_DIR"

if [ -d "$ROOT_FOLDER/jre" ]
then
  JAVAC="$ROOT_FOLDER/jre/bin/java"
else
  JAVAC="/usr/lib/jvm/jre/bin/java"
fi

echo "Starting the server..."
echo "Params: $JAVAC, $TS_DATA_DIR, $LOGGING_LEVEL, $ROOT_FOLDER, $MAIN_JAR_FILE, $JAVA_OPTS"
echo "Run Command: $JAVAC $JAVA_OPTS -DTS_DATA_DIR="$TS_DATA_DIR" -Dlogging.level.="$LOGGING_LEVEL" -cp "$ROOT_FOLDER/lib/*:$MAIN_JAR_FILE" com.testsigma.TestsigmaWebApplication"
$JAVAC $JAVA_OPTS -DTS_DATA_DIR="$TS_DATA_DIR" -Dlogging.level.="$LOGGING_LEVEL" -cp "$ROOT_FOLDER/lib/*:$MAIN_JAR_FILE" com.testsigma.TestsigmaWebApplication