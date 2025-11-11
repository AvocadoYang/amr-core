import dotenv from "dotenv";
import { cleanEnv, str } from "envalid";
import { NetWorkManager } from "./service";
import { RBClient } from "./mq";

dotenv.config();
cleanEnv(process.env, {
  NODE_CONFIG_ENV: str({
    choices: ["development_xnex", "ruifang_testing_area", "px_ruifang"],
    default: "px_ruifang",
  }),
  MODE: str({
    choices: ["debug", "product"],
    default: "product",
  }),
});

class AmrCore {
  private netWorkManager: NetWorkManager;
  private rb: RBClient;
  constructor(){
    this.netWorkManager = new NetWorkManager();
    this.rb = new RBClient();
  }
  
  public async init(){
    await this.netWorkManager.fleetConnect();
    await this.rb.connect();
  }
}

const amrCore = new AmrCore();

(async () => { await amrCore.init() } )()

