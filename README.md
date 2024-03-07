# AMR-Core

## Configuration
Modify `.env` and `configs/*.yaml` 

## Run
`yarn debug`

## Mocking Tips

<!-- ```sh
roslaunch turtlebot3_gazebo turtlebot3_world.launch
``` -->

```sh
roslaunch rosbridge_server rosbridge_websocket.launch
```

```sh
roslaunch turtlebot3_navigation turtlebot3_navigation.launch map_file:=$HOME/map.yaml
```
