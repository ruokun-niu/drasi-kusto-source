# drasi-kusto-source
This repository contains an EXPERIMENTAL Kusto Source reactivator and proxy. It is not an official [Drasi](https://drasi.io) Source. If you are curious to learn more about Drasi, please navigate to our Github page [here](https://github.com/drasi-project)

The Kusto Source is not a typical Drasi Source as it relies on regularly polling the Kusto database for new changes. It should be treated as simply a prototype and should not be used in production environments. In addition, it is not using the Drasi Source SDK and its performance and scalability are highly limited.


## Using the Kusto Source

### Prerequisites
- A running Kusto database
- An AKS cluster with Drasi installed
- az CLI installed
- kubectl CLI installed
- drasi CLI installed


### Building the Docker Images
The Kusto Source and Proxy Docker images can be built using the provided Makefiles. You can customize the `IMAGE_PREFIX` and `DOCKER_TAG_VERSION` variables in the Makefile to suit your needs. 
Run the following commands to build the images:

### Registering the Kusto Source
Please execute the following command to register the Kusto Source using the source provider
```bash
cd devops
drasi apply -f source-provider.yaml
```

### Authentication

#### Solution: Configure AKS and Fix the Authentication Issue
Currently, the Kusto Source is configured to use a user-assigned managed identity for authentication. The following steps will guide you through the process of ensuring that the managed identity is correctly set up and that your AKS cluster can use it to authenticate with the Kusto database.

##### 1. Creating an User-Assigned Managed Identity
You can create a user-assigned managed identity using the Azure CLI:
```bash
az identity create --resource-group <resource-group-name> --name <identity-name>
```

##### 2. Grant Kusto Permissions to the Managed Identity
Please follow this [guide](https://learn.microsoft.com/en-us/azure/data-explorer/configure-managed-identities-cluster?tabs=portal#add-a-user-assigned-identity) for detailed steps on how to assign the necessary permissions to the managed identity for accessing the Kusto database.

##### 3. Configure AKS with Workload Identity
To use the user-assigned managed identity at the pod level, enable Azure Workload Identity on the AKS cluster. This allows your pod to authenticate using the specified managed identity.

###### Step 3.1: Enable Workload Identity
Ensure the AKS cluster has workload identity and OIDC issuer enabled:
```bash
az aks update \
  --resource-group <resource-group-name> \
  --name <aks-cluster-name> \
  --enable-oidc-issuer \
  --enable-workload-identity
```

###### Step 3.2: Get the OIDC Issuer URL
Retrieve the OIDC issuer URL:
```bash
az aks show \
  --resource-group <resource-group-name> \
  --name <aks-cluster-name> \
  --query oidcIssuerProfile.issuerUrl -o tsv
```
Save the output (e.g., `https://<region>.oidc.<region>.aks.azure.com/<issuer-id>`).

###### Step 3.3: Federate the Managed Identity with the Service Account
Create a federated identity credential to link the managed identity to a Kubernetes service account:
```bash
az identity federated-credential create \
  --name <federated-credential-name> \
  --identity-name <identity-name> \
  --resource-group <resource-group-name> \
  --issuer <oidc-issuer-url> \
  --subject system:serviceaccount:drasi-system:kusto-app-sa
```

- `<federated-credential-name>`: A unique name (e.g., kusto-app-federated).
- `<identity-name>`: The name of the user-assigned managed identity created earlier.

##### 4. Update Your Kubernetes Deployment
**NOTE**: In an official Drasi Source, the Source SDK would handle this. This is a workaround for this experimental Kusto Source.

Your application pod needs a service account configured with workload identity annotations. Here's an updated deployment YAML based on your code:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kusto-app-sa
  namespace: drasi-system
  annotations:
    azure.workload.identity/client-id: "<client-id>"
    azure.workload.identity/tenant-id: "<tenant-id>"
```

A copy of the above YAML is provided in `devops/sa.yaml`. Please replace `<client-id>` and `<tenant-id>` with the actual values from your managed identity. Use the following command to apply the service account configuration:
```bash
kubectl apply -f devops/sa.yaml
```

### Deploying the Kusto Source
Now, you can create a YAML file for deploying the Kusto Source. Below is an example deployment YAML file:
```yaml

apiVersion: v1
kind: Source
name: <name-of-your-kusto-source>
spec:
  kind: Kusto
  properties:
    KUSTO_URI: <kusto-cluster-uri>
    KUSTO_DATABASE: <kusto-database-name>
    KUSTO_TABLE: <kusto-table-name>
    PRIMARY_KEY: <primary-key-column>
    KUSTO_QUERY: <kusto-query-to-fetch-data>
    POLL_INTERVAL: <poll-interval-in-seconds> # Optional
    USER_MANAGED_IDENTITY: <client-id>
```
**NOTE**: The performance of bootstrapping has always been an issue that the Drasi team wants to address in the future. We noticed that if the Kusto table contains a significant amount of data, the initial bootstrap (when the Continuous Query is applied) might cause the Source reactivator to crash, leaving the Source and the Query in a broken state. As a result, we added a new field called `KUSTO_QUERY` to allow users to specify the Kusto query result that Drasi will work with. This means that when the continuous query starts, Drasi will use whatever is returned by the `KUSTO_QUERY` as the initial dataset. Additionally, Drasi will only look for new changes that are part of this query result. This is a limiation of the Kusto Source. When using an official Drasi Source, the user does not need to specify a query for bootstrapping.  

You can deploy the Kusto Source using the following command:
```bash
drasi apply -f <your-kusto-source-yaml-file>
```

After applying the YAML file, please also execute the following command for patching the Kubernetes deployment to use the correct service account:
```bash
kubectl patch deployment <name-of-your-kusto-source>-reactivator -n drasi-system --type='json' -p='[
  {"op": "add", "path": "/spec/template/spec/serviceAccountName", "value": "kusto-app-sa"},
  {"op": "add", "path": "/spec/template/metadata/labels/azure.workload.identity~1use", "value": "true"}
]'
```
This step is only necessary for this experimental Kusto Source. In an official Drasi Source, the Source SDK would handle this automatically.


### Deploying the Continuous Query
You can create a YAML file for deploying the Continuous Query. Below is an example deployment YAML file that queries storm events in New York state:
```yaml
apiVersion: v1
kind: ContinuousQuery
name: <name-of-your-continuous-query>
spec:
  mode: query
  sources:    
    subscriptions:
      - id: <name-of-your-kusto-source>
  query: > 
    MATCH 
      (i:StormEvents {State: 'NEW YORK'})
    RETURN
      i.State as State,
      i.EventId as EventId,
      i.EventType as Event,
      i.InjuriesDirect as Injuries,
      i.DeathsDirect as Deaths,
      i.DamageProperty as Damage
```
You can deploy the Continuous Query using the following command:
```bash
drasi apply -f <your-continuous-query-yaml-file>
```

You can also deploy and debug the Kusto Continuous Query using the Drasi VSCode extension.

## Sample
A sample Kusto Source and Continuous Query is provided in the `samples` folder.