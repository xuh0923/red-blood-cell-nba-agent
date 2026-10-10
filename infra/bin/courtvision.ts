#!/usr/bin/env node
import "source-map-support/register.js";
import { App } from "aws-cdk-lib";
import { CourtVisionStack } from "../lib/courtvision-stack.js";

const app = new App();
new CourtVisionStack(app, "CourtVisionStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  description: "Red Blood Cell team - NBA CourtVision Agent"
});
