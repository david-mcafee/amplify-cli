import { S3AccessType, S3PermissionType, S3UserInputs, GroupAccessType } from '../service-walkthrough-types/s3-user-input-types';
import { $TSObject, AmplifyCategories, AmplifySupportedService } from 'amplify-cli-core';
import { JSONUtilities, pathManager } from 'amplify-cli-core';
import { CLIInputSchemaValidator } from 'amplify-cli-core';
import * as fs from 'fs-extra';
import * as path from 'path';
import { buildShortUUID } from './s3-walkthrough';


type ResourcRefType = {
  Ref: string
}

export interface MigrationParams {
   parametersFilepath :string,
   cfnFilepath : string,
   storageParamsFilepath : string,
   parameters: $TSObject,
   cfn: $TSObject,
   storageParams: $TSObject
}


export enum S3CFNPermissionType {
  CREATE = "s3:PutObject",
  READ = "s3:GetObject",
  DELETE = "s3:DeleteObject",
  LIST = "s3:ListBucket"
}

export enum S3StorageParamsPermissionType {
  CREATE_AND_UPDATE = 'create/update',
  READ = "read",
  DELETE = "delete",
}

export interface S3CFNPermissionMapType {
  [S3StorageParamsPermissionType.CREATE_AND_UPDATE]: S3CFNPermissionType[],
  [S3StorageParamsPermissionType.READ]: S3CFNPermissionType[],
  [S3StorageParamsPermissionType.DELETE]: S3CFNPermissionType[],
}

//use this to capture input
interface IObjectS3PermissionType {
  [key: string]: S3PermissionType[];
}
export interface S3PermissionMapType extends IObjectS3PermissionType {
  'create/update': S3PermissionType[],
  read: S3PermissionType[],
  delete: S3PermissionType[],
}

export type S3CFNDependsOn = {
  category: string,
  resourceName: string,
  attributes: string[]
}

export type GroupCFNAccessType = Record<string, S3CFNPermissionType[]>;

export type GroupStorageParamsAccessType = Record<string, S3StorageParamsPermissionType[]>;


//Data generated by amplify which should not be overridden by the user
export type S3FeatureMetadata = {
  dependsOn: S3CFNDependsOn[],
}

export type S3InputStateOptions = {
  resourceName: string;
  inputPayload?: S3UserInputs;
  metadata?: S3FeatureMetadata;
};

/**
 *
 * @param resourceName - Name of S3 resource
 * @returns true  - if resource can be transformed (its cli-inputs file has been generated)
 *          false - otherwise
 */
export function canResourceBeTransformed(resourceName: string):boolean {
  const resourceInputState = new S3InputState(resourceName, undefined);
  return resourceInputState.cliInputFileExists();
}

export class S3InputState {
  static s3InputState: S3InputState;
  _cliInputsFilePath: string; //cli-inputs.json (output) filepath
  _resourceName: string; //user friendly name provided by user
  _category: string; //category of the resource
  _service: string; //AWS service for the resource
  _inputPayload: S3UserInputs | undefined; //S3 options selected by user
  buildFilePath: string;

  constructor(resourceName: string, userInput: S3UserInputs | undefined) {
    this._category = AmplifyCategories.STORAGE;
    this._service = AmplifySupportedService.S3;
    const projectBackendDirPath = pathManager.getBackendDirPath();
    this._cliInputsFilePath = path.resolve(path.join(projectBackendDirPath, AmplifyCategories.STORAGE, resourceName, 'cli-inputs.json'));
    this._resourceName = resourceName;
    this.buildFilePath = path.resolve(path.join(projectBackendDirPath, AmplifyCategories.STORAGE, resourceName, 'build'));
    if (userInput) { //Add flow
      this._inputPayload = userInput;
    } else {
      if (this.cliInputFileExists()){
        this._inputPayload = this.getCliInputPayload(); //Update flow
      } else {
        return; //Migration flow
      }
    }
    //validate CLI inputs
    this.isCLIInputsValid( this._inputPayload );
  }


  getOldS3ParamsForMigration(): MigrationParams{
    const backendDir = pathManager.getBackendDirPath();
    const oldParametersFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, 'parameters.json');
    const oldCFNFilepath = path.join( backendDir, AmplifyCategories.STORAGE, this._resourceName,
                                      `${AmplifySupportedService.S3}-cloudformation-template.json`);
    const oldStorageParamsFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, `storage-params.json`);
    const oldParameters: any = JSONUtilities.readJson(oldParametersFilepath, { throwIfNotExist: true });
    const oldCFN: any = JSONUtilities.readJson(oldCFNFilepath, { throwIfNotExist: true });
    const oldStorageParams: any = JSONUtilities.readJson(oldStorageParamsFilepath, { throwIfNotExist: false }) || {};
    const oldParams : MigrationParams = {
      parametersFilepath : oldParametersFilepath,
      cfnFilepath : oldCFNFilepath,
      storageParamsFilepath : oldStorageParamsFilepath,
      parameters: oldParameters,
      cfn: oldCFN,
      storageParams: oldStorageParams
    }
    return oldParams;
  }

  genInputParametersForMigration(oldS3Params : MigrationParams) : S3UserInputs {
      const oldParams = oldS3Params.parameters;
      const storageParams = oldS3Params.storageParams;
      let userInputs : S3UserInputs = {
        resourceName: this._resourceName,
        bucketName: oldParams.bucketName,
        policyUUID: buildShortUUID(), //Since UUID is unique for every resource, we re-create the policy names with new UUID.
        storageAccess: undefined,
        guestAccess: [],
        authAccess: [],
        triggerFunction: "NONE",
        groupAccess: undefined,
      }
      if ( oldParams.triggerFunction ){
        userInputs.triggerFunction = oldParams.triggerFunction;
      }

      if (oldParams.selectedAuthenticatedPermissions ) {
        userInputs.authAccess = S3InputState.getInputPermissionsFromCfnPermissions( oldParams.selectedAuthenticatedPermissions );
      }

      if ( oldParams.selectedGuestPermissions ) {
        userInputs.guestAccess = S3InputState.getInputPermissionsFromCfnPermissions( oldParams.selectedGuestPermissions );
      }

      if (oldParams.selectedGuestPermissions?.length ) {
        userInputs.storageAccess = S3AccessType.AUTH_AND_GUEST;
      } else {
        if (oldParams.selectedAuthenticatedPermissions?.length){
          userInputs.storageAccess = S3AccessType.AUTH_ONLY;
        }
      }

      if (storageParams && storageParams.hasOwnProperty("groupPermissionMap")){
        userInputs.groupAccess = S3InputState.getPolicyMapFromStorageParamPolicyMap( storageParams.groupPermissionMap );
      }

      return userInputs;
  }

  removeOldS3ConfigFiles( migrationParams : MigrationParams ){
      // Remove old files
      if (fs.existsSync(migrationParams.cfnFilepath)) {
        fs.removeSync(migrationParams.cfnFilepath);
      }
      if (fs.existsSync(migrationParams.parametersFilepath)) {
        fs.removeSync(migrationParams.parametersFilepath);
      }
      if (fs.existsSync(migrationParams.storageParamsFilepath)) {
        fs.removeSync(migrationParams.storageParamsFilepath);
      }
  }

  public migrate(){
    const oldS3Params : MigrationParams = this.getOldS3ParamsForMigration();
    const cliInputs : S3UserInputs = this.genInputParametersForMigration( oldS3Params );
    this.saveCliInputPayload(cliInputs);
    this.removeOldS3ConfigFiles( oldS3Params );
  }

  public cliInputFileExists(): boolean {
    return fs.existsSync(this._cliInputsFilePath);
  }

  public getUserInput() {
    // Read Cli Inputs file if exists
    if (this._inputPayload) {
      return this._inputPayload;
    } else {
      try {
        this._inputPayload = this.getCliInputPayload();
      } catch (e) {
        throw new Error('migrate project with command : amplify migrate <to be decided>');
      }
    }
    return this._inputPayload;
  }

  public async isCLIInputsValid(cliInputs?: S3UserInputs) {
    if (!cliInputs) {
      cliInputs = this.getCliInputPayload();
    }
    const schemaValidator = new CLIInputSchemaValidator(this._service, this._category, "S3UserInputs");
    return await schemaValidator.validateInput(JSON.stringify(cliInputs));
  }

  public static getPermissionTypeFromCfnType(s3CFNPermissionType: S3CFNPermissionType): S3PermissionType {
    switch (s3CFNPermissionType) {
      case S3CFNPermissionType.CREATE:
        return S3PermissionType.CREATE_AND_UPDATE;
      case S3CFNPermissionType.READ:
      case S3CFNPermissionType.LIST:
        return S3PermissionType.READ;
      case S3CFNPermissionType.DELETE:
        return S3PermissionType.DELETE;
      default:
        throw new Error(`Unknown CFN Type: ${s3CFNPermissionType}`);
    }
  }

  public static getPermissionTypeFromStorageParamsType( s3StorageParamsPermissionType : S3StorageParamsPermissionType ): S3PermissionType {
    switch (s3StorageParamsPermissionType) {
        case S3StorageParamsPermissionType.CREATE_AND_UPDATE:
            return S3PermissionType.CREATE_AND_UPDATE;
        case S3StorageParamsPermissionType.READ:
            return S3PermissionType.READ;
        case S3StorageParamsPermissionType.DELETE:
            return S3PermissionType.DELETE;
        default:
          throw new Error(`Unknown Storage Param Type: ${s3StorageParamsPermissionType}`);
    }
  }

  //S3CFNPermissionType
  public static getCfnTypesFromPermissionType(s3PermissionType: S3PermissionType): Array<S3CFNPermissionType> {
    switch (s3PermissionType) {
      case S3PermissionType.CREATE_AND_UPDATE:
        return [S3CFNPermissionType.CREATE];
      case S3PermissionType.READ:
        return [S3CFNPermissionType.READ, S3CFNPermissionType.LIST];
      case S3PermissionType.DELETE:
        return [S3CFNPermissionType.DELETE];
      default:
        throw new Error(`Unknown Permission Type: ${s3PermissionType}`);
    }
  }

  public static getInputPermissionsFromCfnPermissions(selectedGuestPermissions: S3CFNPermissionType[] | undefined) {
    if (selectedGuestPermissions) {
      return selectedGuestPermissions.map(S3InputState.getPermissionTypeFromCfnType);
    } else {
      return []
    }
  }

  public static getInputPermissionsFromStorageParamPermissions( storageParamGroupPermissions: S3StorageParamsPermissionType[] | undefined) {
    if (storageParamGroupPermissions) {
      return storageParamGroupPermissions.map(S3InputState.getPermissionTypeFromStorageParamsType);
    } else {
      return []
    }
  }

  public static getCfnPermissionsFromInputPermissions(selectedPermissions: S3PermissionType[] | undefined) {
    if (selectedPermissions) {
      let selectedCfnPermissions :S3CFNPermissionType[] = []; //S3CFNPermissionType
      for( const selectedPermission of selectedPermissions ){
        selectedCfnPermissions = selectedCfnPermissions.concat( S3InputState.getCfnTypesFromPermissionType(selectedPermission) )
      }
      return selectedCfnPermissions;
    } else {
      return []
    }
  }

  public static getPolicyMapFromCfnPolicyMap(groupCFNPolicyMap: GroupCFNAccessType) {
    if (groupCFNPolicyMap) {
      let result: GroupAccessType = {};
      for (const groupName of Object.keys(groupCFNPolicyMap)) {
        result[groupName] =  S3InputState.getInputPermissionsFromCfnPermissions(groupCFNPolicyMap[groupName])
      }
      return result;
    } else {
      return undefined;
    }
  }

  public static getPolicyMapFromStorageParamPolicyMap(groupStorageParamsPolicyMap: GroupStorageParamsAccessType): GroupAccessType|undefined {
    if (groupStorageParamsPolicyMap) {
      let result: GroupAccessType = {};
      for (const groupName of Object.keys(groupStorageParamsPolicyMap)) {
        result[groupName] =  S3InputState.getInputPermissionsFromStorageParamPermissions(groupStorageParamsPolicyMap[groupName])
      }
      return result;
    } else {
      return undefined;
    }
  }

  public static getPolicyMapFromStorageParamsPolicyMap(groupStorageParamsPolicyMap: GroupStorageParamsAccessType) {
    if (groupStorageParamsPolicyMap) {
      let result: GroupAccessType = {};
      for (const groupName of Object.keys(groupStorageParamsPolicyMap)) {
        result[groupName] =  S3InputState.getInputPermissionsFromStorageParamPermissions(groupStorageParamsPolicyMap[groupName])
      }
      return result;
    } else {
      return undefined;
    }
  }

  updateInputPayload(props: S3InputStateOptions) {
    // Overwrite
    this._inputPayload = props.inputPayload;

    // validate cli-inputs.json
    const schemaValidator = new CLIInputSchemaValidator(this._service, this._category, "S3UserInputs");
    schemaValidator.validateInput(JSON.stringify(this._inputPayload!));
  }

  public static getInstance(props: S3InputStateOptions): S3InputState {
    if (!S3InputState.s3InputState) {
      S3InputState.s3InputState = new S3InputState(props.resourceName, props.inputPayload);
    }
    //update flow
    if (props.inputPayload) {
      S3InputState.s3InputState.updateInputPayload(props);
    }
    return S3InputState.s3InputState;
  }

  public getCliInputPayload(): S3UserInputs {
    let cliInputs: S3UserInputs;
    // Read cliInputs file if exists
    try {
      cliInputs = JSON.parse(fs.readFileSync(this._cliInputsFilePath, 'utf8'));
    } catch (e) {
      throw new Error('migrate project with command : amplify migrate <to be decided>');
    }
    return cliInputs;
  }

  public getCliMetadata(): S3FeatureMetadata | undefined {
    return undefined;
  }

  public saveCliInputPayload(cliInputs: S3UserInputs): void {
    this.isCLIInputsValid(cliInputs);
    this._inputPayload = cliInputs;

    fs.ensureDirSync(path.join(pathManager.getBackendDirPath(), this._category, this._resourceName));

    try {
      JSONUtilities.writeJson(this._cliInputsFilePath, cliInputs);
    } catch (e) {
      throw e;
    }
  }


}