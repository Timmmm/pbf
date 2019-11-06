'use strict';

module.exports = compile;

var version = require('./package.json').version;

function compile(proto) {
    var code = 'var exports = {};\n';
    code += compileRaw(proto) + '\n';
    code += 'return exports;\n';
    return new Function(code)();
}

compile.raw = compileRaw;

function compileRaw(proto, options) {
    options = options || {};

    var moduleType = options.moduleType;

    var pre = '';
    if (moduleType !== 'es6' && moduleType !== 'typescript') {
        pre += '\'use strict\'; ';
    }
    pre += '// code generated by pbf v' + version + '\n';
    if (moduleType === 'typescript') {
        pre += '\nimport Pbf from \'pbf\';\n';
    }

    var context = buildDefaults(buildContext(proto, null), proto.syntax);
    return pre + writeTypes(context, options) + writeContext(context, options);
}

function writeTypes(ctx, options) {
    if (options.moduleType !== 'typescript') {
        return '';
    }

    var i;
    var code = '';

    var fields = ctx._proto.fields;
    if (fields) {
        code += '\nexport interface ' + getTypescriptInterfaceName(ctx) + ' {\n';
        var isOneOfAdded = {};
        for (i = 0; i < fields.length; i++) {
            var field = fields[i];

            var oneOfName = field.oneof;
            if (oneOfName && !isOneOfAdded[oneOfName]) {
                var oneOfValues = getOneOfValues(fields, oneOfName);
                code += '    ' + oneOfName + ': ' + oneOfValues.map(value => JSON.stringify(value)).join(' | ') + ';\n';
                isOneOfAdded[oneOfName] = true;
            }

            code += '    ' + field.name + (field.required ? '' : '?') + ': ' + getTypescriptType(ctx, field);
            if (field.repeated) {
                code += '[]';
            }
            code += ';\n';
        }
        code += '}\n';
    }

    var values = ctx._proto.values;
    if (values) {
        code += '\nexport type ' + getTypescriptEnumKeyTypeName(ctx) + ' = ' +
            Object.keys(values).map(function(key) { return JSON.stringify(key); }).join(' | ') + ';\n';
        code += 'export type ' + getTypescriptEnumValueTypeName(ctx) + ' = ' +
            Object.values(values).map(function(item) { return item.value; }).join(' | ') + ';\n';
    }

    for (i = 0; i < ctx._children.length; i++) {
        code += writeTypes(ctx._children[i], options);
    }

    return code;
}

function getOneOfValues(fields, oneOfName) {
    var oneOfValues = [];
    for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        if (field.oneof === oneOfName) {
            oneOfValues.push(field.name);
        }
    }
    return oneOfValues;
}

function writeContext(ctx, options) {
    var code, i;
    if (!ctx._name) {
        // This is the top-level context
        code = '';
        for (i = 0; i < ctx._children.length; i++) {
            code += writeContext(ctx._children[i], options);
        }
        return code;
    } else if (options.noRead && options.noWrite) {
        return '\n// ' + ctx._fullName + ' ========================================\n';
    } else {
        code = '\n';
        if (ctx._root) {
            if (options.moduleType === 'es6' || options.moduleType === 'typescript') {
                code += 'export const ' + ctx._name + ' = ';
            } else {
                var exportsVar = (options.moduleType === 'global') ? 'self' : 'exports';
                code += 'var ' + ctx._name + ' = ' + exportsVar + '.' + ctx._name + ' = ';
            }
        } else {
            code += ctx._indent + ctx._name + ': ';
        }

        if (ctx._proto.fields) {
            code += '{\n';
            if (ctx._children.length) {
                code += '\n';
            }
            code += writeMessage(ctx, options);
            for (i = 0; i < ctx._children.length; i++) {
                code += ',\n';
                code += writeContext(ctx._children[i], options);
            }
            if (ctx._children.length) {
                code += '\n';
            }
            code += '\n' + ctx._indent + '}' + (ctx._root ? ';\n' : '');
        } else if (ctx._proto.values) {
            code += writeEnum(ctx);
            if (options.moduleType === 'typescript') {
                code += ' as { [K in ' + getTypescriptEnumKeyTypeName(ctx) + ']: { value: ' + getTypescriptEnumValueTypeName(ctx) + ', options: any } }';
            }
            code += (ctx._root ? ';' : '') + '\n';
        }

        return code;
    }
}

function writeMessage(ctx, options) {
    var fields = ctx._proto.fields;

    var code = '';

    if (!options.noRead) {
        code += ctx._indent + '    ' + compileFunctionHead(options, 'read', 'pbf, end', 'pbf: Pbf, end?: number', getTypescriptInterfaceName(ctx)) + ' {\n';
        code += ctx._indent + '        return pbf.readFields(' + ctx._fullName + '._readField, ' + compileDest(ctx) + ', end);\n';
        code += ctx._indent + '    },\n';
        code += ctx._indent + '    ' + compileFunctionHead(options, '_readField', 'tag, obj, pbf', 'tag: number, obj: any, pbf: Pbf', 'void') + ' {\n';

        var hasVarEntry = false;
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var readCode = compileFieldRead(ctx, field);
            var packed = willSupportPacked(ctx, field);
            if (field.type === 'map' && !hasVarEntry) {
                code += ctx._indent + '        var entry';
                if (options.moduleType === 'typescript') {
                    code += ': any';
                }
                code += ';\n';
                hasVarEntry = true;
            }
            code += ctx._indent + '        ' + (i ? 'else if' : 'if') +
                ' (tag === ' + field.tag + ') ' +
                (field.type === 'map' ? ' { ' : '') +
                (
                    field.type === 'map' ? compileMapRead(readCode, field.name) :
                    field.repeated && !packed ? 'obj.' + field.name + '.push(' + readCode + ')' :
                    field.repeated && packed ? readCode : 'obj.' + field.name + ' = ' + readCode
                );

            if (field.oneof) {
                code += ', obj.' + field.oneof + ' = ' + JSON.stringify(field.name);
            }

            code += ';' + (field.type === 'map' ? ' }' : '') + '\n';
        }
        code += ctx._indent + '    }';
        if (!options.noWrite) {
            code += ',\n';
        }
    }

    if (!options.noWrite) {
        code += ctx._indent + '    ' + compileFunctionHead(options, 'write', 'obj, pbf', 'obj: ' + getTypescriptInterfaceName(ctx) + ', pbf: Pbf', 'void') + ' {\n';
        var numRepeated = 0;
        for (i = 0; i < fields.length; i++) {
            field = fields[i];
            var writeCode = field.repeated && !isPacked(field) ?
                compileRepeatedWrite(ctx, field, numRepeated++) :
                field.type === 'map' ? compileMapWrite(ctx, field, numRepeated++) :
                compileFieldWrite(ctx, field, 'obj.' + field.name);
            code += getDefaultWriteTest(ctx, field);
            code += writeCode + ';\n';
        }
        code += ctx._indent + '    }';
    }

    return code;
}

function writeEnum(ctx) {
    return JSON.stringify(ctx._proto.values, null, 4);
}

function compileFunctionHead(options, functionName, params, typedParams, returnType) {
    var moduleType = options.moduleType;
    var code = functionName;
    if (moduleType !== 'es6' && moduleType !== 'typescript') {
        code += ': function ';
    }
    if (moduleType === 'typescript') {
        code += '(' + typedParams + '): ' + returnType;
    } else {
        code += '(' + params + ')';
    }

    return code;
}

function compileDest(ctx) {
    var props = {};
    for (var i = 0; i < ctx._proto.fields.length; i++) {
        var field = ctx._proto.fields[i];
        props[field.name + ': ' + JSON.stringify(ctx._defaults[field.name])] = true;
        if (field.oneof) props[field.oneof + ': undefined'] = true;
    }
    return '{' + Object.keys(props).join(', ') + '}';
}

function isEnum(type) {
    return type && type._proto.values;
}

function getType(ctx, field) {
    if (field.type === 'map') {
        return ctx[getMapMessageName(field.tag)];
    }

    var path = field.type.split('.');
    return path.reduce(function(ctx, name) { return ctx && ctx[name]; }, ctx);
}

function compileFieldRead(ctx, field) {
    var type = getType(ctx, field);
    if (type) {
        if (type._proto.fields) return type._fullName + '.read(pbf, pbf.readVarint() + pbf.pos)';
        if (!isEnum(type)) throw new Error('Unexpected type: ' + type._fullName);
    }

    var fieldType = isEnum(type) ? 'enum' : field.type;

    var prefix = 'pbf.read';
    var signed = fieldType === 'int32' || fieldType === 'int64' ? 'true' : '';
    var suffix = '(' + signed + ')';

    if (willSupportPacked(ctx, field)) {
        prefix += 'Packed';
        suffix = '(obj.' + field.name + (signed ? ', ' + signed : '') + ')';
    }

    switch (fieldType) {
    case 'string':   return prefix + 'String' + suffix;
    case 'float':    return prefix + 'Float' + suffix;
    case 'double':   return prefix + 'Double' + suffix;
    case 'bool':     return prefix + 'Boolean' + suffix;
    case 'enum':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':    return prefix + 'Varint' + suffix;
    case 'sint32':
    case 'sint64':   return prefix + 'SVarint' + suffix;
    case 'fixed32':  return prefix + 'Fixed32' + suffix;
    case 'fixed64':  return prefix + 'Fixed64' + suffix;
    case 'sfixed32': return prefix + 'SFixed32' + suffix;
    case 'sfixed64': return prefix + 'SFixed64' + suffix;
    case 'bytes':    return prefix + 'Bytes' + suffix;
    default:         throw new Error('Unexpected type: ' + field.type);
    }
}

function compileFieldWrite(ctx, field, name) {
    var prefix = 'pbf.write';
    if (isPacked(field)) prefix += 'Packed';

    var postfix = (isPacked(field) ? '' : 'Field') + '(' + field.tag + ', ' + name + ')';

    var type = getType(ctx, field);
    if (type) {
        if (type._proto.fields) return prefix + 'Message(' + field.tag + ', ' + type._fullName + '.write, ' + name + ')';
        if (type._proto.values) return prefix + 'Varint' + postfix;
        throw new Error('Unexpected type: ' + type._fullName);
    }

    switch (field.type) {
    case 'string':   return prefix + 'String' + postfix;
    case 'float':    return prefix + 'Float' + postfix;
    case 'double':   return prefix + 'Double' + postfix;
    case 'bool':     return prefix + 'Boolean' + postfix;
    case 'enum':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':    return prefix + 'Varint' + postfix;
    case 'sint32':
    case 'sint64':   return prefix + 'SVarint' + postfix;
    case 'fixed32':  return prefix + 'Fixed32' + postfix;
    case 'fixed64':  return prefix + 'Fixed64' + postfix;
    case 'sfixed32': return prefix + 'SFixed32' + postfix;
    case 'sfixed64': return prefix + 'SFixed64' + postfix;
    case 'bytes':    return prefix + 'Bytes' + postfix;
    default:         throw new Error('Unexpected type: ' + field.type);
    }
}

function compileMapRead(readCode, name) {
    return 'entry = ' + readCode + '; obj.' + name + '[entry.key] = entry.value';
}

function compileRepeatedWrite(ctx, field, numRepeated) {
    return 'for (' + (numRepeated ? '' : 'var ') +
        'i = 0; i < obj.' + field.name + '.length; i++) ' +
        compileFieldWrite(ctx, field, 'obj.' + field.name + '[i]');
}

function compileMapWrite(ctx, field, numRepeated) {
    var name = 'obj.' + field.name;

    return 'for (' + (numRepeated ? '' : 'var ') +
        'i in ' + name + ') if (Object.prototype.hasOwnProperty.call(' + name + ', i)) ' +
        compileFieldWrite(ctx, field, '{ key: i, value: ' + name + '[i] }');
}

function getMapMessageName(tag) {
    return '_FieldEntry' + tag;
}

function getMapField(name, type, tag) {
    return {
        name: name,
        type: type,
        tag: tag,
        map: null,
        oneof: null,
        required: false,
        repeated: false,
        options: {}
    };
}

function getMapMessage(field) {
    return {
        name: getMapMessageName(field.tag),
        enums: [],
        messages: [],
        extensions: null,
        fields: [
            getMapField('key', field.map.from, 1),
            getMapField('value', field.map.to, 2)
        ]
    };
}

function buildContext(proto, parent) {
    var obj = Object.create(parent);
    obj._proto = proto;
    obj._children = [];
    obj._defaults = {};

    if (parent) {
        parent[proto.name] = obj;

        obj._name = proto.name;
        if (parent._fullName) {
            obj._root = false;
            obj._fullName = parent._fullName + '.' + proto.name;
            obj._indent = parent._indent + '    ';
        } else {
            obj._root = true;
            obj._fullName = proto.name;
            obj._indent = '';
        }
    }

    for (var i = 0; proto.enums && i < proto.enums.length; i++) {
        obj._children.push(buildContext(proto.enums[i], obj));
    }

    for (i = 0; proto.messages && i < proto.messages.length; i++) {
        obj._children.push(buildContext(proto.messages[i], obj));
    }

    for (i = 0; proto.fields && i < proto.fields.length; i++) {
        if (proto.fields[i].type === 'map') {
            obj._children.push(buildContext(getMapMessage(proto.fields[i]), obj));
        }
    }

    return obj;
}

function getDefaultValue(field, value) {
    // Defaults not supported for repeated fields
    if (field.repeated) return [];

    switch (field.type) {
    case 'float':
    case 'double':   return value ? parseFloat(value) : 0;
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'sfixed64': return value ? parseInt(value, 10) : 0;
    case 'string':   return value || '';
    case 'bool':     return value === 'true';
    case 'map':      return {};
    default:         return undefined;
    }
}

function willSupportPacked(ctx, field) {
    var fieldType = isEnum(getType(ctx, field)) ? 'enum' : field.type;

    switch (field.repeated && fieldType) {
    case 'float':
    case 'double':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'enum':
    case 'bool': return true;
    }

    return false;
}

function getTypescriptInterfaceName(type) {
    return 'I' + type._fullName.replace(/\./g, '_');
}

function getTypescriptEnumKeyTypeName(type) {
    return type._fullName.replace(/\./g, '_') + '_Key';
}

function getTypescriptEnumValueTypeName(type) {
    return type._fullName.replace(/\./g, '_') + '_Value';
}

function getTypescriptType(ctx, field) {
    var type;
    switch (field.type) {
    case 'float':
    case 'double':
    case 'uint32':
    case 'uint64':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'sfixed64':
        return 'number';
    case 'bytes':  return 'Uint8Array';
    case 'string': return 'string';
    case 'bool':   return 'boolean';
    case 'map':
        type = getType(ctx, field);
        var keyType = getTypescriptType(ctx, type._proto.fields[0]);
        var valueType = getTypescriptType(ctx, type._proto.fields[1]);
        return '{ [K in ' + keyType + ']: ' + valueType + ' }';
    default:
        type = getType(ctx, field);
        if (isEnum(type)) {
            return getTypescriptEnumValueTypeName(type);
        } else {
            return getTypescriptInterfaceName(type);
        }
    }
}


function setPackedOption(ctx, field, syntax) {
    // No default packed in older protobuf versions
    if (syntax < 3) return;

    // Packed option already set
    if (field.options.packed !== undefined) return;

    // Not a packed field type
    if (!willSupportPacked(ctx, field)) return;

    field.options.packed = 'true';
}

function setDefaultValue(ctx, field, syntax) {
    var options = field.options;
    var type = getType(ctx, field);
    var enumValues = type && type._proto.values;

    // Proto3 does not support overriding defaults
    var explicitDefault = syntax < 3 ? options.default : undefined;

    // Set default for enum values
    if (enumValues && !field.repeated) {
        ctx._defaults[field.name] = enumValues[explicitDefault] || 0;

    } else {
        ctx._defaults[field.name] = getDefaultValue(field, explicitDefault);
    }
}

function buildDefaults(ctx, syntax) {
    var proto = ctx._proto;

    for (var i = 0; i < ctx._children.length; i++) {
        buildDefaults(ctx._children[i], syntax);
    }

    if (proto.fields) {
        for (i = 0; i < proto.fields.length; i++) {
            setPackedOption(ctx, proto.fields[i], syntax);
            setDefaultValue(ctx, proto.fields[i], syntax);
        }
    }

    return ctx;
}

function getDefaultWriteTest(ctx, field) {
    var def = ctx._defaults[field.name];
    var type = getType(ctx, field);
    var code = ctx._indent + '        if (obj.' + field.name;

    if (!field.repeated && (!type || !type._proto.fields)) {
        if (def === undefined || def) {
            code += ' != undefined';
        }
        if (def) {
            code += ' && obj.' + field.name + ' !== ' + JSON.stringify(def);
        }
    }

    return code + ') ';
}

function isPacked(field) {
    return field.options.packed === 'true';
}
