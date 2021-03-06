/*
 * Copyright 2015 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of perseo-fe
 *
 * perseo-fe is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * perseo-fe is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with perseo-fe.
 * If not, see http://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[contacto@tid.es]
 */

'use strict';

var util = require('util'),
    async = require('async'),
    actionStore = require('./actionsStore'),
    executionsStore = require('./executionsStore'),
    emailAction = require('./emailAction'),
    smsAction = require('./smsAction'),
    updateAction = require('./updateAction'),
    postAction = require('./postAction'),
    twitterAction = require('./twitterAction'),
    errors = {},
    myutils = require('../myutils'),
    logger = require('logops'),
    config = require('../../config');

var inProcess = {};

function getInProcessArray(service, servicePath, ruleName, id, type) {
    var inPService,
        inPServicePath,
        inPRule,
        inPEntity,
        inPType;

    inPService = inProcess[service];
    if (!inPService) {
        inPService = inProcess[service] = {};
    }
    inPServicePath = inPService[servicePath];
    if (!inPServicePath) {
        inPServicePath = inPService[servicePath] = {};
    }
    inPRule = inPServicePath[ruleName];
    if (!inPRule) {
        inPRule = inPServicePath[ruleName] = {};
    }
    inPEntity = inPRule[id];
    if (!inPEntity) {
        inPEntity = inPRule[id] = {};
    }
    inPType = inPEntity[type];
    if (!inPType) {
        inPType = inPEntity[type] = [];
    }
    return inPType;
}

function deleteInProcessArray(service, servicePath, ruleName, id, type) {
    var
        servicePathMap = inProcess[service][servicePath],
        ruleMap = servicePathMap[ruleName];

    delete ruleMap[id][type];
    if (Object.keys(ruleMap[id]).length === 0) {
        delete ruleMap[id];
    }
    if (Object.keys(ruleMap).length === 0) {
        delete servicePathMap[ruleMap];
    }
}

function errorsAction(event) {
    var ruleName = event.ruleName;
    if (ruleName === null || ruleName === undefined) {
        return new errors.MissingRuleName(JSON.stringify(event));
    }
    return null;
}

function validateAction(axn) {
    //There is an action
    if (typeof axn.type !== 'string') {
        return new errors.MissingActionType(axn);
    }

    //Action type
    switch (axn.type) {
    case 'email':
    case 'sms':
    case 'update':
    case 'post':
    case 'twitter':
        break;
    default:
        return new errors.UnknownActionType(axn.type);
    }

    //Do not use id/type as attribute
    if (axn.type === 'update' && axn.parameters) {
        if (axn.parameters.name === 'id') {
            return new errors.IdAsAttribute(JSON.stringify(axn.parameters));
        } else if (axn.parameters.name === 'type') {
            return new errors.IdAsAttribute(JSON.stringify(axn.parameters));
        }
    }
    //Everything is OK
    return null;
}

function conditionalExec(action, event, lastTime, callbackW) {
    var rightNow = Date.now(),
        ruleName = event.ruleName,
        eventId = event.id,
        subservice = event.subservice,
        service = event.service,
        noticeId = event.noticeId,
        localError;
    action.interval = Number(action.interval);
    if (isNaN(action.interval)) {
        action.interval = 0;
    }
    if (lastTime + action.interval < rightNow) {
        async.series([
            function(callbackS) {
                switch (action.type) {
                case 'email':
                    emailAction.doIt(action, event, callbackS);
                    break;
                case 'sms':
                    smsAction.doIt(action, event, callbackS);
                    break;
                case 'update':
                    updateAction.doIt(action, event, callbackS);
                    break;
                case 'post':
                    postAction.doIt(action, event, callbackS);
                    break;
                case 'twitter':
                    twitterAction.doIt(action, event, callbackS);
                    break;
                default:
                    localError = new errors.UnknownActionType(action.type);
                    myutils.logErrorIf(localError);
                    return callbackS(localError, null);
                }
            },
            executionsStore.Update.bind(null, service, subservice, ruleName, eventId, noticeId)
        ], callbackW);
    }
    else {
        logger.info('discarding action, too recent lastTime %d interval %d now %d',
            lastTime, action.interval, rightNow);
        callbackW(null);
    }
}
function slaveExec(action, event, alreadyExecuted, callback) {
    var ruleName = event.ruleName,
        eventId = event.id,
        subservice = event.subservice,
        service = event.service;
    if (!alreadyExecuted) {
        async.waterfall(
            [
                executionsStore.LastTime.bind(null, service, subservice, ruleName, eventId),
                conditionalExec.bind(null, action, event)
            ],
            function(err, tasks) {
                callback(err);
            });
    } else {
        return callback(null);
    }
}

function execAxn(action, event, cbCe) {
    var ruleName = event.ruleName,
        eventId = event.id,
        subservice = event.subservice,
        service = event.service,
        noticeId = event.noticeId;

    if (config.isMaster) {
        async.waterfall(
            [
                executionsStore.LastTime.bind(null, service, subservice, ruleName, eventId),
                conditionalExec.bind(null, action, event)
            ],
            function(err, tasks) {
                cbCe(err);
            });
    } else {
        async.waterfall(
            [
                executionsStore.AlreadyDone.bind(null, service, subservice, ruleName, eventId, noticeId),
                slaveExec.bind(null, action, event)
            ],
            function(err, tasks) {
                cbCe(err);
            });
    }
}

function doOneAction(eventArray, callback) {

    var event,
        ruleName,
        subservice,
        service,
        id,
        type,
        localError;
    event = eventArray[0];
    ruleName = event.ruleName;
    subservice = event.subservice;
    service = event.service;
    id = event.id;
    type = event.type;
    logger.debug('event %j', event);
    localError = errorsAction(event);
    if (localError !== null) {
        myutils.logErrorIf(localError);
        return callback(localError, null);
    }
    actionStore.Find(service, subservice, ruleName, function(err, action) {
        if (err) {
            return callback(err, null);
        }
        localError = validateAction(action);
        if (localError !== null) {
            myutils.logErrorIf(localError);
            return callback(localError, null);
        }
        return execAxn(action, event, function(error) {
                eventArray.shift();
                if (eventArray.length === 0) { //no more elements to process
                    deleteInProcessArray(service, subservice, ruleName, id, type);
                    return callback(error);
                }
                else {  // recursive call
                    return doOneAction(eventArray, callback);
                }
            }
        );
    });
}

function DoAction(event, callback) {
    var ruleName = event.ruleName,
        subservice = event.subservice,
        service = event.service,
        id = event.id,
        type = event.type,
        localError,
        eventArray;

    logger.debug('service %s, subservice %s, event %j', service, subservice, event);
    localError = errorsAction(event);
    if (localError !== null) {
        myutils.logErrorIf(localError);
        return callback(localError, null);
    }
    eventArray = getInProcessArray(service, subservice, ruleName, id, type);
    eventArray.push(event);
    if (eventArray.length === 1) { // the one inserted right now
        doOneAction(eventArray, callback); // start process
    }
}

module.exports.Do = DoAction;
module.exports.errorsAction = errorsAction;
module.exports.validateAction = validateAction;
/**
 * Constructors for possible errors from this module
 *
 * @type {Object}
 */
module.exports.errors = errors;

(function() {
    errors.MissingActionType = function MissingActionType(msg) {
        this.name = 'MISSING_ACTION_TYPE';
        this.message = 'missing type in action ' + msg;
        this.httpCode = 400;
    };

    errors.UnknownActionType = function UnknownActionType(msg) {
        this.name = 'UNKNOWN_ACTION_TYPE';
        this.message = 'unknown action type ' + msg;
        this.httpCode = 400;
    };

    errors.MissingRuleName = function MissingRuleName(msg) {
        this.name = 'MISSING_ACTION_RULE_NAME';
        this.message = 'missing rule name for action ' + msg;
        this.httpCode = 400;
    };
    errors.IdAsAttribute = function IdAsAttribute(msg) {
        this.name = 'ID_ATTRIBUTE';
        this.message = 'id as attribute ' + msg;
        this.httpCode = 400;
    };
    errors.TypeAsAttribute = function TypeAsAttribute(msg) {
        this.name = 'TYPE_ATTRIBUTE';
        this.message = 'type as attribute ' + msg;
        this.httpCode = 400;
    };
    Object.keys(errors).forEach(function(element) {
        util.inherits(errors[element], Error);
    });
})();
