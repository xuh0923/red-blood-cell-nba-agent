import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps,
  aws_bedrockagentcore as agentcore,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks
} from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export class CourtVisionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    if (Stack.of(this).region !== "us-east-1") throw new Error("CourtVision can only be deployed to us-east-1");

    const assets = new s3.Bucket(this, "Assets", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
        allowedOrigins: ["*"],
        allowedHeaders: ["content-type"],
        exposedHeaders: ["ETag"],
        maxAge: 3600
      }],
      lifecycleRules: [
        { id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: Duration.days(1) }
      ],
      removalPolicy: RemovalPolicy.RETAIN
    });
    const web = new s3.Bucket(this, "Web", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const jobs = new dynamodb.Table(this, "Jobs", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN
    });
    // Retained for compatibility with the deployed stack. The fast path below does not invoke it.
    const agentLogGroup = new logs.LogGroup(this, "AgentLogs", {
      logGroupName: "/aws/vendedlogs/bedrock-agentcore/courtvision",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const agentRuntime = new agentcore.Runtime(this, "AnalysisAgent", {
      runtimeName: "courtvision_analysis_agent",
      description: "Standby narrative runtime; media and vision do not depend on it",
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: path.join(root, "services/agentcore-runtime/dist"),
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ["main.js"]
      }),
      tracingEnabled: false,
      loggingConfigs: [{ logType: agentcore.LogType.APPLICATION_LOGS, destination: agentcore.LoggingDestination.cloudWatchLogs(agentLogGroup) }],
      manageDeliveryResourcePolicy: false
    });
    assets.grantRead(agentRuntime);

    const mediaRole = new iam.Role(this, "MediaConvertRole", {
      assumedBy: new iam.ServicePrincipal("mediaconvert.amazonaws.com"),
      description: "Read CourtVision sources and write optimized playback media"
    });
    assets.grantReadWrite(mediaRole);

    const visionWorker = new lambdaNode.NodejsFunction(this, "ContinuousVisionWorker", {
      entry: path.join(root, "services/api/src/vision-handler.ts"), handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      memorySize: 2048, timeout: Duration.minutes(10), bundling: { minify: true, sourceMap: true },
      environment: { ASSET_BUCKET: assets.bucketName, JOBS_TABLE: jobs.tableName }
    });
    assets.grantReadWrite(visionWorker);
    jobs.grantReadWriteData(visionWorker);
    visionWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ["rekognition:StartLabelDetection", "rekognition:GetLabelDetection"], resources: ["*"] }));

    const analyzer = new lambdaNode.NodejsFunction(this, "AnalyzeWorker", {
      entry: path.join(root, "services/api/src/analyze-handler.ts"), handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      memorySize: 1024, timeout: Duration.minutes(5), bundling: { minify: true, sourceMap: true },
      environment: {
        ASSET_BUCKET: assets.bucketName,
        JOBS_TABLE: jobs.tableName,
        MEDIACONVERT_ROLE_ARN: mediaRole.roleArn
      }
    });
    assets.grantReadWrite(analyzer);
    jobs.grantReadWriteData(analyzer);
    analyzer.addToRolePolicy(new iam.PolicyStatement({ actions: ["mediaconvert:CreateJob"], resources: ["*"] }));
    mediaRole.grantPassRole(analyzer.grantPrincipal);

    const startVision = new tasks.LambdaInvoke(this, "StartContinuousVision", {
      lambdaFunction: visionWorker,
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        action: "start", jobId: sfn.JsonPath.stringAt("$.id"), videoKey: sfn.JsonPath.stringAt("$.videoKey"),
        videoDurationSeconds: sfn.JsonPath.numberAt("$.videoDurationSeconds"),
        videoWidth: sfn.JsonPath.numberAt("$.videoWidth"), videoHeight: sfn.JsonPath.numberAt("$.videoHeight"),
        sourceFps: sfn.JsonPath.numberAt("$.sourceFps")
      }),
      resultPath: "$.vision"
    });
    const pollVision = new tasks.LambdaInvoke(this, "PollContinuousVision", {
      lambdaFunction: visionWorker,
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        action: "poll", jobId: sfn.JsonPath.stringAt("$.id"), videoKey: sfn.JsonPath.stringAt("$.videoKey"),
        videoDurationSeconds: sfn.JsonPath.numberAt("$.videoDurationSeconds"),
        videoWidth: sfn.JsonPath.numberAt("$.videoWidth"), videoHeight: sfn.JsonPath.numberAt("$.videoHeight"),
        sourceFps: sfn.JsonPath.numberAt("$.sourceFps"), labelJobId: sfn.JsonPath.stringAt("$.vision.labelJobId")
      }),
      resultPath: "$.vision"
    });
    const finalize = new tasks.LambdaInvoke(this, "PrepareAnalysisAndPlayback", {
      lambdaFunction: analyzer,
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        jobId: sfn.JsonPath.stringAt("$.id"), videoKey: sfn.JsonPath.stringAt("$.videoKey"),
        videoFileName: sfn.JsonPath.stringAt("$.videoFileName"), dataKey: sfn.JsonPath.stringAt("$.dataKey"),
        videoDurationSeconds: sfn.JsonPath.numberAt("$.videoDurationSeconds"), trackingKey: sfn.JsonPath.stringAt("$.vision.trackingKey")
      })
    });
    const wait = new sfn.Wait(this, "WaitForContinuousVision", { time: sfn.WaitTime.duration(Duration.seconds(10)) });
    const failed = new sfn.Fail(this, "ContinuousVisionFailed", { error: "ContinuousVisionFailed" });
    const choice = new sfn.Choice(this, "ContinuousVisionFinished");
    wait.next(pollVision).next(choice);
    choice.when(sfn.Condition.stringEquals("$.vision.visionStatus", "IN_PROGRESS"), wait)
      .when(sfn.Condition.stringEquals("$.vision.visionStatus", "SUCCEEDED"), finalize)
      .otherwise(failed);
    const workflow = new sfn.StateMachine(this, "Workflow", {
      definitionBody: sfn.DefinitionBody.fromChainable(startVision.next(choice)),
      timeout: Duration.minutes(60), tracingEnabled: true
    });

    const apiHandler = new lambdaNode.NodejsFunction(this, "ApiHandler", {
      entry: path.join(root, "services/api/src/handler.ts"), handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      memorySize: 512, timeout: Duration.seconds(15), bundling: { minify: true, sourceMap: true },
      environment: { ASSET_BUCKET: assets.bucketName, JOBS_TABLE: jobs.tableName, STATE_MACHINE_ARN: workflow.stateMachineArn }
    });
    assets.grantReadWrite(apiHandler);
    jobs.grantReadWriteData(apiHandler);
    workflow.grantStartExecution(apiHandler);

    const api = new HttpApi(this, "Api", {
      corsPreflight: {
        allowOrigins: ["*"], allowHeaders: ["content-type"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS], maxAge: Duration.hours(1)
      }
    });
    const integration = new HttpLambdaIntegration("ApiIntegration", apiHandler);
    for (const route of [
      ["/health", HttpMethod.GET], ["/works", HttpMethod.GET], ["/storage", HttpMethod.GET],
      ["/videos/check", HttpMethod.POST], ["/jobs", HttpMethod.POST], ["/jobs/{id}", HttpMethod.GET],
      ["/jobs/{id}/start", HttpMethod.POST], ["/jobs/{id}/video/complete", HttpMethod.POST],
      ["/jobs/{id}/video/abort", HttpMethod.POST]
    ] as const) {
      api.addRoutes({ path: route[0], methods: [route[1]], integration });
      api.addRoutes({ path: `/api${route[0]}`, methods: [route[1]], integration });
    }
    const apiDomain = Fn.select(2, Fn.split("/", api.apiEndpoint));
    const assetOrigin = origins.S3BucketOrigin.withOriginAccessControl(assets);
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
      },
      additionalBehaviors: {
        "media/*": {
          origin: assetOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS
        },
        "api/*": {
          origin: new origins.HttpOrigin(apiDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER
        }
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.minutes(1) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.minutes(1) }
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100
    });

    const mediaStatus = new lambdaNode.NodejsFunction(this, "MediaStatusWorker", {
      entry: path.join(root, "services/api/src/media-status-handler.ts"), handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      memorySize: 256, timeout: Duration.seconds(30), bundling: { minify: true, sourceMap: true },
      environment: { JOBS_TABLE: jobs.tableName, MEDIA_BASE_URL: `https://${distribution.distributionDomainName}` }
    });
    jobs.grantReadWriteData(mediaStatus);
    new events.Rule(this, "MediaConvertStatusRule", {
      eventPattern: {
        source: ["aws.mediaconvert"],
        detailType: ["MediaConvert Job State Change"],
        detail: { status: ["COMPLETE", "ERROR", "CANCELED"] }
      },
      targets: [new eventTargets.LambdaFunction(mediaStatus)]
    });

    new s3deploy.BucketDeployment(this, "DeployWeb", {
      sources: [s3deploy.Source.asset(path.join(root, "apps/web/dist"))],
      destinationBucket: web, distribution, distributionPaths: ["/*"]
    });

    new CfnOutput(this, "CloudFrontUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "AssetBucketName", { value: assets.bucketName });
    new CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.agentRuntimeArn });
    new CfnOutput(this, "MediaConvertRoleArn", { value: mediaRole.roleArn });
  }
}
