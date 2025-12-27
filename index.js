"use strict";

const pascalCase = (camelCase) =>
  camelCase.slice(0, 1).toUpperCase() + camelCase.slice(1);

const randomText = (length) =>
  Array.from({ length }, () => Math.random().toString(36)[2]).join("");

class ServerlessPlugin {
  constructor(serverless, options, { log }) {
    this.serverless = serverless;
    this.options = options;
    this.logger = log;

    this.hooks = {
      "before:deploy:deploy": this.Deploy.bind(this),
    };

    this.region = serverless.getProvider("aws").getRegion();

    serverless.configSchemaHandler.defineFunctionProperties("aws", {
      type: "object",
      properties: { enableSnsDlq: { type: "boolean" } },
    });

    serverless.configSchemaHandler.defineFunctionEventProperties("aws", "sns", {
      type: "object",
      properties: { enableSnsDlq: { type: "boolean" } },
    });
  }

  _validateQueueName = (queueName) => {
    if (queueName.length > 80) {
      this.logger.error(
        `Generated queue name [${queueName}] is longer than 80 characters.`
      );
      process.exit(1);
    }
  };

  Deploy = async () => {
    const accountId = await this.serverless.getProvider("aws").getAccountId();
    const functions = this.serverless.service.functions;
    const template =
      this.serverless.service.provider.compiledCloudFormationTemplate;

    Object.entries(functions).flatMap(
      async ([fnName, fnDef]) => {
        if (fnDef.enableSnsDlq !== false) {
          const snsEvents = (fnDef.events || [])
            .filter((evt) => evt.sns)
            .map((evt) => evt.sns);

          if (snsEvents.length > 0) this._configure(accountId, template, fnName, fnDef, snsEvents);
        }
      }
    );
  };

  _configure = (accountId, template, fnName, fnDef, snsEvents) => {
    const dlqName = `${fnDef.name}-dlq`;
    this._validateQueueName(dlqName);

    const dlqArn = `arn:aws:sqs:${this.region}:${accountId}:${dlqName}`;
    const dlqUrl = `https://sqs.${this.region}.amazonaws.com/${accountId}/${dlqName}`;

    // Define SQS DeadLetterQueue for the function
    const queueId = pascalCase(`${fnName}SQSDeadLetterQueue`);
    const queueDef = {
      Type: "AWS::SQS::Queue",
      Properties: { QueueName: dlqName },
    };
    template.Resources[queueId] = queueDef;

    // Add DLQ_QUEUE_URL automatically to the function environment variables
    const funcId = pascalCase(`${fnName}LambdaFunction`);
    const funcDef = template.Resources[funcId];

    if (funcDef.Properties.Environment)
      funcDef.Properties.Environment.Variables["DLQ_QUEUE_URL"] = dlqUrl;
    else
      funcDef.Properties.Environment = { Variables: { DLQ_QUEUE_URL: dlqUrl } };

    template.Resources[funcId] = funcDef;

    // Update redrive policy to each SNS subscriptions
    const arns = [];
    snsEvents.forEach((sns) => {
      const snsSubId = pascalCase(`${fnName}SnsSubscription${(sns.arn || sns).split(":").pop()}`);

      const snsSubDef = template.Resources[snsSubId];
      snsSubDef.Properties["RedrivePolicy"] = { deadLetterTargetArn: dlqArn };

      template.Resources[snsSubId] = snsSubDef;
      arns.push(sns.arn || sns)
    })

    // Attach queue policy to the DLQ
    const queuePolicyId = pascalCase(`${fnName}SQSDeadLetterQueuePolicy`);
    template.Resources[queuePolicyId] = {
      Type: "AWS::SQS::QueuePolicy",
      Properties: {
        Queues: [{ Ref: queueId }],
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: {
            Effect: "Allow",
            Principal: { Service: "sns.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: { "Fn::GetAtt": [queueId, "Arn"] },
            Condition: { ArnEquals: { "aws:SourceArn": arns } },
          },
        },
      },
    }
  }
}

module.exports = ServerlessPlugin;
