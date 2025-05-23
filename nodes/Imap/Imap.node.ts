import { ICredentialTestFunctions, ICredentialsDecrypted, IExecuteFunctions, INodeCredentialTestResult, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { allResourceDefinitions } from './operations/ResourcesList';
import { getAllResourceNodeParameters } from './utils/CommonDefinitions';
import { ImapCredentialsData } from '../../credentials/ImapCredentials.credentials';
import { ImapFlowErrorCatcher, createImapClient } from './utils/ImapUtils';
import { NodeApiError } from 'n8n-workflow';
import { loadMailboxList } from './utils/SearchFieldParameters';
import { CREDENTIALS_TYPE_CORE_IMAP_ACCOUNT, CREDENTIALS_TYPE_THIS_NODE, credentialNames, getImapCredentials } from './utils/CredentialsSelector';

// Add a new constant for our new credential type
const CREDENTIALS_TYPE_FROM_INPUT = 'fromInput';

export class Imap implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'IMAP',
    name: 'imap',
    icon: 'file:node-imap-icon.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: 'Retrieve emails via IMAP',
    defaults: {
      name: 'IMAP',
    },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      // using credentials from Core IMAP Trigger node
      {
        // eslint-disable-next-line n8n-nodes-base/node-class-description-credentials-name-unsuffixed
        name: credentialNames[CREDENTIALS_TYPE_CORE_IMAP_ACCOUNT],
        required: true,
        displayOptions: {
          show: {
            authentication: [
              CREDENTIALS_TYPE_CORE_IMAP_ACCOUNT,
            ],
          },
        },
      },
      // using credentials from this node
      {
        // eslint-disable-next-line n8n-nodes-base/node-class-description-credentials-name-unsuffixed
        name: credentialNames[CREDENTIALS_TYPE_THIS_NODE],
        required: true,
        // "testedBy" function doesn't work in current version of n8n
        // testedBy: 'testImapCredentials',
        displayOptions: {
          show: {
            authentication: [
              CREDENTIALS_TYPE_THIS_NODE,
            ],
          },
        },
      },
      // We don't define credentials for fromInput mode
      // TODO: using OAuth2
      /*{
        name: credentialNames[CREDENTIALS_TYPE_OAUTH2],
        required: true,
        displayOptions: {
          show: {
            authentication: [
              CREDENTIALS_TYPE_OAUTH2,
            ],
          },
        },
      },*/
    ],
    properties: [
      // credential type
      {
        displayName: 'Credential Type',
        name: 'authentication',
        type: 'options',
        // eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-options
        default: CREDENTIALS_TYPE_THIS_NODE,
        options: [
          {
            // eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
            name: 'IMAP',
            value: CREDENTIALS_TYPE_THIS_NODE,
            description: 'Use credentials from this node',
          },
          {
            // eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
            name: 'N8N IMAP Trigger Node',
            value: CREDENTIALS_TYPE_CORE_IMAP_ACCOUNT,
            description: 'Use existing credentials from N8N IMAP Trigger node',
          },
          {
            name: 'From Input',
            value: CREDENTIALS_TYPE_FROM_INPUT,
            description: 'Use credentials from previous node input',
          },
          /*{
            name: 'OAuth2',
            value: CREDENTIALS_TYPE_OAUTH2,
            description: 'Use OAuth2 authentication',
          },*/
        ],
      },

      // Add fields for FromInput credentials
      {
        displayName: 'Input Field for Credentials',
        name: 'credentialsField',
        type: 'string',
        default: 'credentials',
        description: 'The field in the input data that contains the credentials',
        placeholder: 'credentials',
        displayOptions: {
          show: {
            authentication: [
              CREDENTIALS_TYPE_FROM_INPUT,
            ],
          },
        },
      },

      // eslint-disable-next-line n8n-nodes-base/node-param-default-missing
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: allResourceDefinitions.map((resourceDef) => resourceDef.resource),
        default: allResourceDefinitions[0].resource.value,
      },

      // combine all parameters from all operations
      ...allResourceDefinitions.map((resourceDef) => getAllResourceNodeParameters(resourceDef)).flat(),

    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][] > {
    // Get the first item to determine if we're using input credentials
    const FIRST_ITEM_INDEX = 0;
    const authentication = this.getNodeParameter('authentication', FIRST_ITEM_INDEX) as string;
    
    // Get credentials - either from n8n credential store or from input
    let credentials: ImapCredentialsData;
    
    if (authentication === CREDENTIALS_TYPE_FROM_INPUT) {
      // Get the items that were passed in
      const items = this.getInputData();
      
      // Make sure we have at least one item
      if (items.length === 0) {
        throw new NodeApiError(this.getNode(), {}, {
          message: 'No input items provided',
        });
      }
      
      // Get the field name that contains the credentials
      const credentialsField = this.getNodeParameter('credentialsField', FIRST_ITEM_INDEX) as string;
      
      // Get the credentials from the first item
      const inputCredentials = items[FIRST_ITEM_INDEX].json[credentialsField];
      
      if (!inputCredentials) {
        throw new NodeApiError(this.getNode(), {}, {
          message: `No credentials found in field "${credentialsField}"`,
        });
      }
      
      // Validate the credentials
      if (!inputCredentials.host || !inputCredentials.user || !inputCredentials.password) {
        throw new NodeApiError(this.getNode(), {}, {
          message: 'Credentials must contain at least host, user, and password fields',
        });
      }
      
      // Extract the credentials
      credentials = {
        host: inputCredentials.host as string,
        port: inputCredentials.port as number || 993,
        user: inputCredentials.user as string,
        password: inputCredentials.password as string,
        tls: inputCredentials.tls !== false, // Default to true if not specified
        allowUnauthorizedCerts: inputCredentials.allowUnauthorizedCerts === true,
      };
    } else {
      // Use the standard method to get credentials
      credentials = await getImapCredentials(this);
    }

    // create imap client and connect
    const N8N_LOG_LEVEL = process.env.N8N_LOG_LEVEL || 'info';
    const ENABLE_DEBUG_LOGGING = (N8N_LOG_LEVEL === 'debug');
    const client = createImapClient(credentials, this.logger, ENABLE_DEBUG_LOGGING);

    try {
      await client.connect();
    } catch (error) {
      this.logger.error(`Connection failed: ${error.message}`);
      throw new NodeApiError(this.getNode(), {}, {
        message: error.responseText || error.message || 'Unknown error',
      });
    }

    // try/catch to close connection in any case
    try {
      // get node parameters
      const FIRST_ITEM_INDEX = 0; // resource and operation are the same for all items
      const resource = this.getNodeParameter('resource', FIRST_ITEM_INDEX) as string;
      const operation = this.getNodeParameter('operation', FIRST_ITEM_INDEX) as string;

      var resultBranches: INodeExecutionData[][] = [];
      var resultItems: INodeExecutionData[] = [];
      resultBranches.push(resultItems);

      // run corresponding operation
      const handler = allResourceDefinitions.find((resourceDef) => resourceDef.resource.value === resource)?.operationDefs.find((operationDef) => operationDef.operation.value === operation);
      if (handler) {
        // running operation in a loop for each input item
        const items = this.getInputData();

        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
          try {
            // some errors are not thrown but logged by ImapFlow internally, so we try to catch them
            ImapFlowErrorCatcher.getInstance().startErrorCatching();

            const result = await handler.executeImapAction(this, itemIndex, client);
            if (result) {
              resultItems.push(...result);
            } else {
              this.logger.warn(`Operation "${operation}" for resource "${resource}" returned no data`);
            }
          } catch (error) {
            const internalImapErrors = ImapFlowErrorCatcher.getInstance().stopAndGetErrors();
            const internalImapErrorsMessage = internalImapErrors.join(", \n");

            if (internalImapErrors.length > 0) {
              this.logger.error(`IMAP server reported errors: ${internalImapErrorsMessage}`);
            }

            if (error instanceof NodeApiError) {
              // don't include internal IMAP errors, because the error message is already composed by the handler
              throw error;
            }

            // seems to be unknown error, check IMAP internal errors and include them in the error message

            var errorMessage = error.responseText || error.message || undefined;
            if (!errorMessage) {
              if (internalImapErrorsMessage) {
                errorMessage = internalImapErrorsMessage;
              } else {
                errorMessage = 'Unknown error';
              }
            }
            this.logger.error(`Operation "${operation}" for resource "${resource}" failed: ${errorMessage}`);
            this.logger.error(JSON.stringify(error));
            var errorDetails : any = {
              message: errorMessage,
            };
            if (internalImapErrorsMessage) {
              errorDetails.description = "The following errors were reported by the IMAP server: \n" + internalImapErrorsMessage;
            }
            throw new NodeApiError(this.getNode(), {}, errorDetails);
          }
        }

      } else {
        this.logger.error(`Unknown operation "${operation}" for resource "${resource}"`);
        throw new NodeApiError(this.getNode(), {}, {
          message: `Unknown operation "${operation}" for resource "${resource}"`,
        });
      }

      // close connection
      client.logout();
      this.logger?.info('IMAP connection closed');

    } catch (error) {
      // close connection and rethrow error
      client.logout();
      this.logger?.error(`IMAP connection closed. Error: ${error.message}`);
      throw error;
    }

    return resultBranches;
  };

  methods = {
    listSearch: {
      loadMailboxList: loadMailboxList,
    },
    credentialTest: {
      async testImapCredentials(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
        const credentials = credential.data as unknown as ImapCredentialsData;

        // create imap client and connect
        try {
          const client = createImapClient(credentials);
          await client.connect();
          client.logout();
        } catch (error) {
          return {
            status: 'Error',
            message: error.message,
          };
        }
        return {
          status: 'OK',
          message: 'Success',
        };
      },
    },
  };
}
