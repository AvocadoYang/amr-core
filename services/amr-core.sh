#!/bin/bash

source /home/kenmec/.bashrc
source /opt/ros/noetic/setup.bash
source /home/kenmec/catkin_ws/devel/setup.bash
source /home/kenmec/static_ws/devel/setup.bash

\. "/home/kenmec/.nvm/nvm.sh"
cd /home/kenmec/amr-core
nvm use 16
npm i -g yarn
yarn debug
