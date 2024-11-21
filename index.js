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
      properties: { setDlq: { type: "boolean" } },
    });

    serverless.configSchemaHandler.defineFunctionEventProperties("aws", "sns", {
      type: "object",
      properties: { setDlq: { type: "boolean" } },
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
    const functions = this.serverless.service.functions;
    const template =
      this.serverless.service.provider.compiledCloudFormationTemplate;

    const validateSubs = Object.entries(functions).flatMap(
      async ([fnName, fnDef]) => {
        if (fnDef.setDlq !== false) {
          const snsEvents = (fnDef.events || [])
            .filter((evt) => evt.sns)
            .map((evt) => evt.sns);

          await snsEvents.forEach((snsEvent) => {
            this._addSQSDeadLetter(template, fnName, fnDef, snsEvents);
          });
        }
      }
    );

    await Promise.all(validateSubs);
  };

  _addSQSDeadLetter = (template, fnName, fnDef, snsEvents) => {
    const accountId = (snsEvents[0].arn || snsEvents[0]).split(":")[4];

    const dlqName = `${fnDef.name}-dlq`;
    this._validateQueueName(dlqName);

    const dlqArn = `arn:aws:sqs:${this.region}:${accountId}:${dlqName}`;
    const dlqUrl = `https://sqs.${this.region}.amazonaws.com/${accountId}/${dlqName}`;

    const queueId = pascalCase(`${fnName}SQSDeadLetterQueue`);
    const queueDef = {
      Type: "AWS::SQS::Queue",
      Properties: { QueueName: dlqName },
    };
    template.Resources[queueId] = queueDef;

    const funcId = pascalCase(`${fnName}LambdaFunction`);
    const funcDef = template.Resources[funcId];

    if (funcDef.Properties.Environment)
      funcDef.Properties.Environment.Variables["DLQ_QUEUE_URL"] = dlqUrl;
    else
      funcDef.Properties.Environment = { Variables: { DLQ_QUEUE_URL: dlqUrl } };

    template.Resources[funcId] = funcDef;

    const CHUNK_SIZE = 10;

    for (let i = 0; i < snsEvents.length; i += CHUNK_SIZE) {
      const queuePolicyId = pascalCase(
        `${fnName}SQSDeadLetterQueuePolicyIter${i}`
      );
      const policyStatements = [];

      const chunk = snsEvents.slice(i, i + CHUNK_SIZE);
      chunk.forEach((sns) => {
        if (sns.setDlq !== false) {
          const snsSubId = pascalCase(
            `${fnName}SnsSubscription${(sns.arn || sns).split(":").pop()}`
          );

          const snsSubDef = template.Resources[snsSubId];
          snsSubDef.Properties["RedrivePolicy"] = {
            deadLetterTargetArn: dlqArn,
          };

          template.Resources[snsSubId] = snsSubDef;

          policyStatements.push({
            Effect: "Allow",
            Principal: { Service: "sns.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: { "Fn::GetAtt": [queueId, "Arn"] },
            Condition: { ArnEquals: { "aws:SourceArn": sns.arn || sns } },
          });
        }
      });

      if (policyStatements.length > 0) {
        const queuePolicyDef = {
          Type: "AWS::SQS::QueuePolicy",
          Properties: {
            Queues: [{ Ref: queueId }],
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: policyStatements,
            },
          },
        };

        template.Resources[queuePolicyId] = queuePolicyDef;
      }
    }
  };
}

module.exports = ServerlessPlugin;
