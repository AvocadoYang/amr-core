enum Footprint {
    HORIZONTAL = 0,
    VERTICAL = 1,
    SQUARE = 2, // 不可旋轉
    ROUND = 3, // 可旋轉
    ALONE = 4
  }
type PeripheralType = "CHARGING" | "DISPATCH" | "STANDBY" | "STORAGE" | "EXTRA" | "ELEVATOR" | "ROBOTIC_ARM" | "CONVEYOR" | "LIFT_GATE" | "PALLETIZER"


type Location = {
    id: string;
    locationId: string;
    x: number;
    y: number;
    canRotate: boolean;
    areaType: PeripheralType;
    cost: number;
    connectedRoadIds: string[];
    footprint: Footprint; // no insert to db
    neighborIds: string[]; // no insert to db
};

type Road = {
    id: string;
    roadId: string;
    roadType: 'oneWayRoad' | 'twoWayRoad';
    spot1Id: string;
    spot2Id: string;
    disabled: boolean;
    priority: number;
    limit: boolean;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cost: number;
    validYawList: number[] | '*';
};

export type ZoneType = {
    id: string;
    name: string;
    backgroundColor: string;
    category: string[];
    tagSetting: {
      speed_limit: number | null;
      hight_limit: number | null;
      forbidden_car: string[] | null;
      limitNum: number | null;
      view_available: string | null;
    };
    startPoint: {
      startX: number;
      startY: number;
    };
    endPoint: {
      endX: number;
      endY: number;
    };
};


export type MapType = {
    locations: Location[],
    roads: Road[],
    zones: ZoneType[],
    regions: ZoneType[]
}