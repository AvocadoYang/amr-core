#!/bin/bash

set -ex

sudo chmod ug+x /home/kenmec/amr-core/services/amr-core.sh
sudo ln -sf /home/kenmec/amr-core/services/kenmec-amr-core.service /etc/systemd/system/
sudo systemctl daemon-reload
echo "1/2 System Services installed."
systemctl enable kenmec-amr-core
echo "2/2 AMR Core Enabled."
