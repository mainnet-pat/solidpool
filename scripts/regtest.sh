#!/bin/bash
# A real node for test/real-node.ts: unmodified BCHN and Fulcrum, in regtest, with the
# relay policy of a public node, on ports of their own.
#   scripts/regtest.sh up | down
set -eu
BCHN=mainnet/bitcoin-cash-node:v29.0.0
FULCRUM=cculianu/fulcrum:latest
RPC=28443; P2P=28444; ELECTRUM=60001; WS=60003
case "${1:-}" in
  up)
    docker run -d --name pools-bchn --network host --tmpfs /data "$BCHN" bitcoind -regtest -server=1 -txindex=1 \
      -datadir=/data -rpcuser=user -rpcpassword=password -rpcallowip=127.0.0.1 -rpcbind=127.0.0.1 -rpcport=$RPC -port=$P2P \
      -acceptnonstdtxn=0 -upgrade12activationtime=1762596456 -rpcworkqueue=128 > /dev/null
    CLI="docker exec pools-bchn bitcoin-cli -regtest -datadir=/data -rpcport=$RPC -rpcuser=user -rpcpassword=password"
    until $CLI getblockcount > /dev/null 2>&1; do sleep 1; done
    # Fulcrum waits for a node with blocks.
    $CLI generatetoaddress 1 "$($CLI getnewaddress)" > /dev/null
    docker run -d --name pools-fulcrum --network host --tmpfs /data "$FULCRUM" Fulcrum -b 127.0.0.1:$RPC -u user -p password \
      -t 127.0.0.1:$ELECTRUM -w 127.0.0.1:$WS -T 0.5 > /dev/null
    echo "bchn rpc $RPC, fulcrum ws://127.0.0.1:$WS"
    ;;
  down)
    docker rm -f pools-bchn pools-fulcrum > /dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 up|down"; exit 1 ;;
esac
