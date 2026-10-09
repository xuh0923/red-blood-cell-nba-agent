import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps,
  aws_bedrockagentcore as agentcore,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks
} from "aws-cdk-lib";
import { HttpApi, CorsHttpMethod, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export class CourtVisionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    if (Stack.of(this).region !== "us-east-1") {
      throw new Error("CourtVision can only be deployed to us-east-1 for this competition");
    }

    const assets = new s3.Bucket(this, "Assets", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: ["*"],
        allowedHeaders: ["content-type"],
        maxAge: 3600
      }],
      lifecycleRules: [{ id: "expire-intermediate-files", prefix: "jobs/", expiration: Duration.days(7) }],
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

    const agentLogGroup = new logs.LogGroup(this, "AgentLogs", {
      logGroupName: "/aws/vendedlogs/bedrock-agentcore/courtvision",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const agentRuntime = new agentcore.Runtime(this, "AnalysisAgent", {
      runtimeName: "courtvision_analysis_agent",
      description: "Multimodal NBA possession analysis agent for CourtVision",
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: path.join(root, "services/agentcore-runtime/dist"),
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ["main.js"]
      }),
      environmentVariables: {
        MODEL_ID: "global.anthropic.claude-sonnet-4-6"
      },
      tracingEnabled: false,
      loggingConfigs: [{
        logType: agentcore.LogType.APPLICATION_LOGS,
        destination: agentcore.LoggingDestination.cloudWatchLogs(agentLogGroup)
      }],
      manageDeliveryResourcePolicy: false
    });
    assets.grantRead(agentRuntime);
    agentRuntime.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["*"]
    }));

    const analyzer = new lambdaNode.NodejsFunction(this, "AnalyzeWorker", {
      entry: path.join(root, "services/api/src/analyze-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(10),
      bundling: { minify: true, sourceMap: true },
      environment: {
        ASSET_BUCKET: assets.bucketName,
        JOBS_TABLE: jobs.tableName,
        AGENT_RUNTIME_ARN: agentRuntime.agentRuntimeArn
      }
    });
    assets.grantReadWrite(analyzer);
    jobs.grantReadWriteData(analyzer);
    agentRuntime.grantInvokeRuntime(analyzer);

    const analyzeTask = new tasks.LambdaInvoke(this, "AnalyzeWithAgentCore", {
      lambdaFunction: analyzer,
      payload: sfn.TaskInput.fromObject({
        jobId: sfn.JsonPath.stringAt("$.jobId"),
        videoKey: sfn.JsonPath.stringAt("$.videoKey"),
        dataKey: sfn.JsonPath.stringAt("$.dataKey"),
        videoDurationSeconds: sfn.JsonPath.numberAt("$.videoDurationSeconds"),
        frames: sfn.JsonPath.objectAt("$.frames")
      }),
      resultPath: "$.agentResult",
      taskTimeout: sfn.Timeout.duration(Duration.minutes(10))
    });
    analyzeTask.addRetry({
      errors: ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"],
      interval: Duration.seconds(3),
      maxAttempts: 2,
      backoffRate: 2
    });

    const workflow = new sfn.StateMachine(this, "Workflow", {
      definitionBody: sfn.DefinitionBody.fromChainable(analyzeTask),
      timeout: Duration.minutes(30),
      tracingEnabled: true
    });

    const apiHandler = new lambdaNode.NodejsFunction(this, "ApiHandler", {
      entry: path.join(root, "services/api/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      bundling: { minify: true, sourceMap: true },
      environment: {
        ASSET_BUCKET: assets.bucketName,
        JOBS_TABLE: jobs.tableName,
        STATE_MACHINE_ARN: workflow.stateMachineArn
      }
    });
    assets.grantPut(apiHandler, "input/*");
    jobs.grantReadWriteData(apiHandler);
    workflow.grantStartExecution(apiHandler);

    const api = new HttpApi(this, "Api", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowHeaders: ["content-type"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1)
      }
    });
    const integration = new HttpLambdaIntegration("ApiIntegration", apiHandler);
    api.addRoutes({ path: "/jobs", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/jobs/{id}", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/jobs/{id}/start", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/api/jobs", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/api/jobs/{id}", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/api/jobs/{id}/start", methods: [HttpMethod.POST], integration });

    const apiDomain = Fn.select(2, Fn.split("/", api.apiEndpoint));

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
      },
      additionalBehaviors: {
        "api/*": {
          origin: new origins.HttpOrigin(apiDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY
          }),
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

    new s3deploy.BucketDeployment(this, "DeployWeb", {
      sources: [s3deploy.Source.asset(path.join(root, "apps/web/dist"))],
      destinationBucket: web,
      distribution,
      distributionPaths: ["/*"]
    });

    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: ["*"]
    }));

    new CfnOutput(this, "CloudFrontUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "AssetBucketName", { value: assets.bucketName });
    new CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.agentRuntimeArn });
  }
}
