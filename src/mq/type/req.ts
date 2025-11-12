interface Base<A> {
    cmd_id: A;
    id: string;
    flag: "REQ";
}


interface Test extends Base<"TS">{
    test: string;
}

export type AllReq = Test 