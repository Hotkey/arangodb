/* jshint globalstrict:true, strict:true, maxlen: 5000 */
/* global describe, before, after, it, require*/

// //////////////////////////////////////////////////////////////////////////////
// / @brief tests for user access rights
// /
// / @file
// /
// / DISCLAIMER
// /
// / Copyright 2017 ArangoDB GmbH, Cologne, Germany
// /
// / Licensed under the Apache License, Version 2.0 (the "License");
// / you may not use this file except in compliance with the License.
// / You may obtain a copy of the License at
// /
// /     http://www.apache.org/licenses/LICENSE-2.0
// /
// / Unless required by applicable law or agreed to in writing, software
// / distributed under the License is distributed on an "AS IS" BASIS,
// / WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// / See the License for the specific language governing permissions and
// / limitations under the License.
// /
// / Copyright holder is ArangoDB GmbH, Cologne, Germany
// /
// / @author Michael Hackstein
// / @author Copyright 2017, ArangoDB GmbH, Cologne, Germany
// //////////////////////////////////////////////////////////////////////////////

'use strict';

const expect = require('chai').expect;
const users = require('@arangodb/users');
const helper = require('@arangodb/user-helper');
const errors = require('@arangodb').errors;
const tasks = require('@arangodb/tasks');
const pu = require('@arangodb/process-utils');
const download = require('internal').download;
const dbName = helper.dbName;
const colName = helper.colName;
const rightLevels = helper.rightLevels;
const keySpaceId = 'task_collection_level_update_keyspace';

const userSet = helper.userSet;
const systemLevel = helper.systemLevel;
const dbLevel = helper.dbLevel;
const colLevel = helper.colLevel;

const arango = require('internal').arango;
const db = require('internal').db;
for (let l of rightLevels) {
  systemLevel[l] = new Set();
  dbLevel[l] = new Set();
  colLevel[l] = new Set();
}

const switchUser = (user, dbname) => {
  arango.reconnect(arango.getEndpoint(), dbname, user, '');
};

const wait = (keySpaceId, key) => {
  for (let i = 0; i < 200; i++) {
    if (getKey(keySpaceId, key)) break;
    require('internal').wait(0.1);
  }
};

const createKeySpace = (keySpaceId) => {
  return executeJS(`return global.KEYSPACE_CREATE('${keySpaceId}', 128, true);`).body === 'true';
};

const dropKeySpace = (keySpaceId) => {
  executeJS(`global.KEYSPACE_DROP('${keySpaceId}');`);
};

const getKey = (keySpaceId, key) => {
  return executeJS(`return global.KEY_GET('${keySpaceId}', '${key}');`).body === 'true';
};

const executeJS = (code) => {
  let httpOptions = pu.makeAuthorizationHeaders({
    username: 'root',
    password: ''
  });
  httpOptions.method = 'POST';
  httpOptions.timeout = 1800;
  httpOptions.returnBodyOnError = true;
  return download(arango.getEndpoint().replace('tcp', 'http') + `/_db/${dbName}/_admin/execute?returnAsJSON=true`,
    code,
    httpOptions);
};

switchUser('root', '_system');
helper.removeAllUsers();

describe('User Rights Management', () => {
  before(helper.generateAllUsers);
  after(helper.removeAllUsers);

  it('should check if all users are created', () => {
    switchUser('root', '_system');
    expect(userSet.size).to.equal(helper.userCount);
    for (let name of userSet) {
      expect(users.document(name), `Could not find user: ${name}`).to.not.be.undefined;
    }
  });

  it('should test rights for', () => {
    for (let name of userSet) {
      let canUse = false;
      try {
        switchUser(name, dbName);
        canUse = true;
      } catch (e) {
        canUse = false;
      }

      if (canUse) {
        describe(`user ${name}`, () => {

          before(() => {
            switchUser(name, dbName);
            expect(createKeySpace(keySpaceId)).to.equal(true, 'keySpace creation failed!');
          });

          after(() => {
            dropKeySpace(keySpaceId);
          });

          describe('update on collection level', () => {
            const rootTestCollection = (switchBack = true) => {
              switchUser('root', dbName);
              let col = db._collection(colName);
              if (switchBack) {
                switchUser(name, dbName);
              }
              return col !== null;
            };

            const rootPrepareCollection = () => {
              if (rootTestCollection(false)) {
                db._collection(colName).truncate();
                db._collection(colName).save({_key: '123'});
              }
              switchUser(name, dbName);
            };

            describe('update a document', () => {
              before(() => {
                db._useDatabase(dbName);
                rootPrepareCollection();
              });

              it('by key', () => {
                expect(rootTestCollection()).to.equal(true, 'Precondition failed, the collection does not exist');
                const taskIdUpdate = 'task_collection_level_update_by_key' + name;
                const taskUpdate = {
                  id: taskIdUpdate,
                  name: taskIdUpdate,
                  command: `(function (params) {
                    try {
                      const db = require('@arangodb').db;
                      db._collection('${colName}').update('123', {foo: 'bar'});
                      global.KEY_SET('${keySpaceId}', '${name}_update_status', true);
                    } catch (e) {
                      global.KEY_SET('${keySpaceId}', '${name}_update_status', false);
                    }finally {
                      global.KEY_SET('${keySpaceId}', '${name}_update', true);
                    }
                  })(params);`
                };
                const taskIdReplace = 'task_collection_level_replace_by_key' + name;
                const taskReplace = {
                  id: taskIdReplace,
                  name: taskIdReplace,
                  command: `(function (params) {
                    try {
                      const db = require('@arangodb').db;
                      db._collection('${colName}').replace('123', {foo: 'baz'});
                      global.KEY_SET('${keySpaceId}', '${name}_replace_status', true);
                    } catch (e) {
                      global.KEY_SET('${keySpaceId}', '${name}_replace_status', false);
                    }finally {
                      global.KEY_SET('${keySpaceId}', '${name}_replace', true);
                    }
                  })(params);`
                };
                if ((dbLevel['rw'].has(name) || dbLevel['ro'].has(name)) &&
                   colLevel['rw'].has(name)) {
                  let col = db._collection(colName);
                  expect(col.document('123').foo).to.not.equal('bar', 'Precondition failed, document already has the attribute set.');
                  tasks.register(taskUpdate);
                  wait(keySpaceId, `${name}_update`);
                  expect(getKey(keySpaceId, `${name}_update_status`)).to.equal(true, `${name} the update did not pass through...`);
                  expect(col.document('123').foo).to.equal('bar', `${name} the update did not pass through...`);

                  tasks.register(taskReplace);
                  wait(keySpaceId, `${name}_replace`);
                  expect(getKey(keySpaceId, `${name}_replace_status`)).to.equal(true, `${name} the update did not pass through...`);
                  expect(col.document('123').foo).to.equal('baz', `${name} the replace did not pass through...`);
                } else {
                  let hasReadAccess = ((dbLevel['rw'].has(name) || dbLevel['ro'].has(name)) &&
                    (colLevel['rw'].has(name) || colLevel['ro'].has(name)));
                  if (hasReadAccess) {
                    let col = db._collection(colName);
                    expect(col.document('123').foo).to.not.equal('bar', 'Precondition failed, document already has the attribute set.');
                  }
                  tasks.register(taskUpdate);
                  wait(keySpaceId, `${name}_update`);
                  expect(getKey(keySpaceId, `${name}_update_status`)).to.not.equal(true, `${name} managed to update the document with insufficient rights`);
                  if (hasReadAccess) {
                    let col = db._collection(colName);
                    expect(col.document('123').foo).to.not.equal('bar', `${name} managed to update the document with insufficient rights`);
                  }

                  tasks.register(taskReplace);
                  wait(keySpaceId, `${name}_replace`);
                  expect(getKey(keySpaceId, `${name}_replace_status`)).to.not.equal(true, `${name} managed to replace the document with insufficient rights`);
                  if (hasReadAccess) {
                    let col = db._collection(colName);
                    expect(col.document('123').foo).to.not.equal('baz', `${name} managed to replace the document with insufficient rights`);
                  }
                }
              });

              it('by aql', () => {
                expect(rootTestCollection()).to.equal(true, 'Precondition failed, the collection does not exist');
                let q = `FOR x IN ${colName} UPDATE x WITH {foo: 'bar'} IN ${colName} RETURN NEW`;
                let q2 = `FOR x IN ${colName} REPLACE x WITH {foo: 'baz'} IN ${colName} RETURN NEW`;
                const taskIdUpdate = 'task_collection_level_update_by_aql' + name;
                const taskUpdate = {
                  id: taskIdUpdate,
                  name: taskIdUpdate,
                  command: `(function (params) {
                    try {
                      const db = require('@arangodb').db;
                      db._query("${q}");
                      global.KEY_SET('${keySpaceId}', '${name}_update_status', true);
                    } catch (e) {
                      global.KEY_SET('${keySpaceId}', '${name}_update_status', false);
                    }finally {
                      global.KEY_SET('${keySpaceId}', '${name}_update', true);
                    }
                  })(params);`
                };
                const taskIdReplace = 'task_collection_level_replace_by_aql' + name;
                const taskReplace = {
                  id: taskIdReplace,
                  name: taskIdReplace,
                  command: `(function (params) {
                    try {
                      const db = require('@arangodb').db;
                      db._query("${q2}");
                      global.KEY_SET('${keySpaceId}', '${name}_replace_status', true);
                    } catch (e) {
                      global.KEY_SET('${keySpaceId}', '${name}_replace_status', false);
                    }finally {
                      global.KEY_SET('${keySpaceId}', '${name}_replace', true);
                    }
                  })(params);`
                };
                if ((dbLevel['rw'].has(name) || dbLevel['ro'].has(name)) &&
                   (colLevel['rw'].has(name))) {
                  let col = db._collection(colName);
                  tasks.register(taskUpdate);
                  wait(keySpaceId, `${name}_update`);
                  expect(getKey(keySpaceId, `${name}_update_status`)).to.equal(true, `${name} the update did not pass through...`);
                  expect(col.document('123').foo).to.equal('bar');

                  tasks.register(taskReplace);
                  wait(keySpaceId, `${name}_replace`);
                  expect(getKey(keySpaceId, `${name}_replace_status`)).to.equal(true, `${name} the update did not pass through...`);
                  expect(col.document('123').foo).to.equal('baz');
                } else {
                  let hasReadAccess = ((dbLevel['rw'].has(name) || dbLevel['ro'].has(name)) &&
                    (colLevel['rw'].has(name) || colLevel['ro'].has(name)));
                  tasks.register(taskUpdate);
                  wait(keySpaceId, `${name}_update`);
                  expect(getKey(keySpaceId, `${name}_update_status`)).to.not.equal(true, `${name} managed to update the document with insufficient rights`);

                  if (hasReadAccess) {
                    let col = db._collection(colName);
                    expect(col.document('123').foo).to.not.equal('bar', `${name} managed to update the document with insufficient rights`);
                  }

                  tasks.register(taskReplace);
                  wait(keySpaceId, `${name}_replace`);
                  expect(getKey(keySpaceId, `${name}_replace_status`)).to.not.equal(true, `${name} managed to replace the document with insufficient rights`);

                  if (hasReadAccess) {
                    let col = db._collection(colName);
                    expect(col.document('123').foo).to.not.equal('baz', `${name} managed to replace the document with insufficient rights`);
                  }
                }
              });
            });
          });
        });
      }
    }
  });
});
