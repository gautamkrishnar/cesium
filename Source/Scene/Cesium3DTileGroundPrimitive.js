/*global define*/
define([
        '../Core/Cartesian3',
        '../Core/Color',
        '../Core/ColorGeometryInstanceAttribute',
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/destroyObject',
        '../Core/Ellipsoid',
        '../Core/Geometry',
        '../Core/GeometryAttribute',
        '../Core/GeometryAttributes',
        '../Core/GeometryInstance',
        '../Core/IndexDatatype',
        '../Core/Matrix4',
        '../Core/OrientedBoundingBox',
        '../Core/PrimitiveType',
        '../Core/TranslationRotationScale',
        '../Renderer/Buffer',
        '../Renderer/BufferUsage',
        '../Renderer/DrawCommand',
        '../Renderer/RenderState',
        '../Renderer/ShaderProgram',
        '../Renderer/ShaderSource',
        '../Renderer/VertexArray',
        '../Shaders/ShadowVolumeFS',
        '../Shaders/ShadowVolumeVS',
        './BlendingState',
        './DepthFunction',
        './Pass',
        './StencilFunction',
        './StencilOperation'
    ], function(
        Cartesian3,
        Color,
        ColorGeometryInstanceAttribute,
        ComponentDatatype,
        defaultValue,
        defined,
        destroyObject,
        Ellipsoid,
        Geometry,
        GeometryAttribute,
        GeometryAttributes,
        GeometryInstance,
        IndexDatatype,
        Matrix4,
        OrientedBoundingBox,
        PrimitiveType,
        TranslationRotationScale,
        Buffer,
        BufferUsage,
        DrawCommand,
        RenderState,
        ShaderProgram,
        ShaderSource,
        VertexArray,
        ShadowVolumeFS,
        ShadowVolumeVS,
        BlendingState,
        DepthFunction,
        Pass,
        StencilFunction,
        StencilOperation) {
    'use strict';

    function Cesium3DTileGroundPrimitive(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        this._positions = options.positions;
        this._offsets = options.offsets;
        this._counts = options.counts;
        this._indexOffsets = options.indexOffsets;
        this._indexCounts = options.indexCounts;
        this._indices = options.indices;

        this._ellispoid = defaultValue(options.ellipsoid, Ellipsoid.WGS84);
        this._minimumHeight = options.minimumHeight;
        this._maximumHeight = options.maximumHeight;
        this._center = options.center;
        this._quantizedOffset = options.quantizedOffset;
        this._quantizedScale = options.quantizedScale;

        this._boundingVolume = options.boundingVolume;
        this._boundingVolumes = new Array(this._offsets.length);

        this._batchTableResources = options.batchTableResources;

        this._va = undefined;
        this._sp = undefined;
        this._spPick = undefined;

        this._rsStencilPreloadPass = undefined;
        this._rsStencilDepthPass = undefined;
        this._rsColorPass = undefined;
        this._rsPickPass = undefined;

        this._commands = undefined;
        this._pickCommands = undefined;
    }

    function createBoundingVolume(buffer, offset, count, center) {
        var positions = new Array(count);
        for (var i = 0; i < count; ++i) {
            positions[i] = Cartesian3.unpack(buffer, offset + i * 3);
        }

        var bv = OrientedBoundingBox.fromPoints(positions);
        Cartesian3.add(bv.center, center, bv.center);
        return bv;
    }

    var attributeLocations = {
        position : 0,
        color : 1,
        a_batchId : 2
    };

    var scratchDecodeMatrix = new Matrix4();
    var scratchEncodedPosition = new Cartesian3();
    var scratchNormal = new Cartesian3();
    var scratchScaledNormal = new Cartesian3();
    var scratchMinHeightPosition = new Cartesian3();
    var scratchMaxHeightPosition = new Cartesian3();

    function createVertexArray(primitive, context) {
        if (!defined(primitive._positions)) {
            return;
        }

        var positions = primitive._positions;
        var offsets = primitive._offsets;
        var counts = primitive._counts;
        var indexOffsets = primitive._indexOffsets;
        var indexCounts = primitive._indexCounts;
        var indices = primitive._indices;
        var boundingVolumes = primitive._boundingVolumes;
        var center = primitive._center;
        var ellipsoid = primitive._ellispoid;

        var quantizedOffset = primitive._quantizedOffset;
        var quantizedScale = primitive._quantizedScale;
        var decodeMatrix = Matrix4.fromTranslationRotationScale(new TranslationRotationScale(quantizedOffset, undefined, quantizedScale), scratchDecodeMatrix);

        // TODO: get feature colors
        var randomColors = [Color.fromRandom({alpha : 0.5}), Color.fromRandom({alpha : 0.5})];
        primitive._colors = [];
        var tempLength = offsets.length;
        for (var n = 0; n < tempLength; ++n) {
            primitive._colors[n] = randomColors[n % randomColors.length];
        }

        var positionsLength = positions.length;
        var colorsLength = positionsLength / 3 * 4;
        var batchedPositions = new Float32Array(positionsLength * 2.0);
        var batchedColors = new Uint8Array(colorsLength * 2);
        var batchedIds = new Uint16Array(positionsLength / 3 * 2);
        var batchedOffsets = new Array(offsets.length);
        var batchedCounts = new Array(counts.length);
        var batchedIndexOffsets = new Array(indexOffsets.length);
        var batchedIndexCounts = new Array(indexCounts.length);

        var wallIndicesLength = positions.length / 3 * 6;
        var indicesLength = indices.length;
        var batchedIndices = new Uint32Array(indicesLength * 2 + wallIndicesLength);

        var colors = primitive._colors;
        colorsLength = colors.length;

        var i;
        var j;
        var color;
        var rgba;

        var buffers = {};
        for (i = 0; i < colorsLength; ++i) {
            rgba = colors[i].toRgba();
            if (!defined(buffers[rgba])) {
                buffers[rgba] = {
                    positionLength : counts[i],
                    indexLength : indexCounts[i],
                    offset : 0,
                    indexOffset : 0
                };
            } else {
                buffers[rgba].positionLength += counts[i];
                buffers[rgba].indexLength += indexCounts[i];
            }

            boundingVolumes[i] = createBoundingVolume(positions, offsets[i], counts[i], center);
        }

        var object;
        var byColorPositionOffset = 0;
        var byColorIndexOffset = 0;
        for (rgba in buffers) {
            if (buffers.hasOwnProperty(rgba)) {
                object = buffers[rgba];
                object.offset = byColorPositionOffset;
                object.indexOffset = byColorIndexOffset;

                var positionLength = object.positionLength * 2;
                var indexLength = object.indexLength * 2 + object.positionLength * 6;

                byColorPositionOffset += positionLength;
                byColorIndexOffset += indexLength;

                object.indexLength = indexLength;
            }
        }

        var batchedDrawCalls = [];

        for (rgba in buffers) {
            if (buffers.hasOwnProperty(rgba)) {
                object = buffers[rgba];

                batchedDrawCalls.push({
                    color : Color.fromRgba(parseInt(rgba)),
                    offset : object.indexOffset,
                    count : object.indexLength
                });
            }
        }

        primitive._batchedIndices = batchedDrawCalls;

        var minHeight = primitive._minimumHeight;
        var maxHeight = primitive._maximumHeight;

        for (i = 0; i < colorsLength; ++i) {
            color = colors[i];
            rgba = color.toRgba();

            var red = Color.floatToByte(color.red);
            var green = Color.floatToByte(color.green);
            var blue = Color.floatToByte(color.blue);
            var alpha = Color.floatToByte(color.alpha);

            object = buffers[rgba];
            var positionOffset = object.offset;
            var positionIndex = positionOffset * 3;
            var colorIndex = positionOffset * 4;
            var idIndex = positionOffset;

            var polygonOffset = offsets[i];
            var polygonCount = counts[i];

            batchedOffsets[i] = positionOffset;
            batchedCounts[i] = polygonCount * 2;

            for (j = 0; j < polygonCount * 3; j += 3) {
                var encodedPosition = Cartesian3.unpack(positions, polygonOffset * 3 + j, scratchEncodedPosition);
                var rtcPosition = Matrix4.multiplyByPoint(decodeMatrix, encodedPosition, encodedPosition);
                var position = Cartesian3.add(rtcPosition, center, rtcPosition);

                var normal = ellipsoid.geodeticSurfaceNormal(position, scratchNormal);
                var scaledPosition = ellipsoid.scaleToGeodeticSurface(position, position);
                var scaledNormal = Cartesian3.multiplyByScalar(normal, minHeight, scratchScaledNormal);
                var minHeightPosition = Cartesian3.add(scaledPosition, scaledNormal, scratchMinHeightPosition);

                scaledNormal = Cartesian3.multiplyByScalar(normal, maxHeight, scaledNormal);
                var maxHeightPosition = Cartesian3.add(scaledPosition, scaledNormal, scratchMaxHeightPosition);

                Cartesian3.subtract(maxHeightPosition, center, maxHeightPosition);
                Cartesian3.subtract(minHeightPosition, center, minHeightPosition);

                Cartesian3.pack(maxHeightPosition, batchedPositions, positionIndex);
                Cartesian3.pack(minHeightPosition, batchedPositions, positionIndex + 3);

                batchedColors[colorIndex]     = red;
                batchedColors[colorIndex + 1] = green;
                batchedColors[colorIndex + 2] = blue;
                batchedColors[colorIndex + 3] = alpha;

                batchedColors[colorIndex + 4] = red;
                batchedColors[colorIndex + 5] = green;
                batchedColors[colorIndex + 6] = blue;
                batchedColors[colorIndex + 7] = alpha;

                batchedIds[idIndex] = i;
                batchedIds[idIndex + 1] = i;

                positionIndex += 6;
                colorIndex += 8;
                idIndex += 2;
            }

            var indicesIndex = object.indexOffset;

            var indexOffset = indexOffsets[i];
            var indexCount = indexCounts[i];

            batchedIndexOffsets[i] = indicesIndex;
            batchedIndexCounts[i] = indexCount * 2 + (polygonCount - 1) * 6;

            for (j = 0; j < indexCount; j += 3) {
                var i0 = indices[indexOffset + j] - polygonOffset;
                var i1 = indices[indexOffset + j + 1] - polygonOffset;
                var i2 = indices[indexOffset + j + 2] - polygonOffset;

                batchedIndices[indicesIndex++] = i0 * 2 + positionOffset;
                batchedIndices[indicesIndex++] = i1 * 2 + positionOffset;
                batchedIndices[indicesIndex++] = i2 * 2 + positionOffset;

                batchedIndices[indicesIndex++] = i2 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = i1 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = i0 * 2 + 1 + positionOffset;
            }

            for (j = 0; j < polygonCount - 1; ++j) {
                batchedIndices[indicesIndex++] = j * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = (j + 1) * 2 + positionOffset;
                batchedIndices[indicesIndex++] = j * 2 + positionOffset;

                batchedIndices[indicesIndex++] = j * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = (j + 1) * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = (j + 1) * 2 + positionOffset;
            }

            object.offset += polygonCount * 2;
            object.indexOffset = indicesIndex;
        }

        primitive._positions = undefined;
        primitive._offsets = batchedOffsets;
        primitive._counts = batchedCounts;
        primitive._indexOffsets = batchedIndexOffsets;
        primitive._indexCounts = batchedIndexCounts;

        var positionBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : batchedPositions,
            usage : BufferUsage.STATIC_DRAW
        });
        var colorBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : batchedColors,
            usage : BufferUsage.STATIC_DRAW
        });
        var idBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : batchedIds,
            usage : BufferUsage.STATIC_DRAW
        });
        var indexBuffer = Buffer.createIndexBuffer({
            context : context,
            typedArray : batchedIndices,
            usage : BufferUsage.STATIC_DRAW,
            indexDatatype : IndexDatatype.UNSIGNED_INT
        });

        var vertexAttributes = [{
            index : attributeLocations.position,
            vertexBuffer : positionBuffer,
            componentDatatype : ComponentDatatype.FLOAT,
            componentsPerAttribute : 3
        }, {
            index : attributeLocations.color,
            vertexBuffer : colorBuffer,
            componentDatatype : ComponentDatatype.UNSIGNED_BYTE,
            componentsPerAttribute : 4,
            normalize : true
        }, {
            index : attributeLocations.a_batchId,
            vertexBuffer : idBuffer,
            componentDatatype : ComponentDatatype.UNSIGNED_SHORT,
            componentsPerAttribute : 1
        }];

        primitive._va = new VertexArray({
            context : context,
            attributes : vertexAttributes,
            indexBuffer : indexBuffer
        });
    }

    function createShaders(primitive, context) {
        if (defined(primitive._sp)) {
            return;
        }

        var vs = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [ShadowVolumeVS]
        });

        primitive._sp = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : vs,
            fragmentShaderSource : ShadowVolumeFS,
            attributeLocations : attributeLocations
        });

        var pickVS = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [primitive._batchTableResources.getPickVertexShaderCallback()(ShadowVolumeVS)]
        });
        var pickFS = new ShaderSource({
            sources : [primitive._batchTableResources.getPickFragmentShaderCallback()(ShadowVolumeFS)]
        });
        primitive._spPick = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : pickVS,
            fragmentShaderSource : pickFS,
            attributeLocations : attributeLocations
        });
    }

    var stencilPreloadRenderState = {
        colorMask : {
            red : false,
            green : false,
            blue : false,
            alpha : false
        },
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.ALWAYS,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.DECREMENT_WRAP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            backFunction : StencilFunction.ALWAYS,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.INCREMENT_WRAP,
                zPass : StencilOperation.INCREMENT_WRAP
            },
            reference : 0,
            mask : ~0
        },
        depthTest : {
            enabled : false
        },
        depthMask : false
    };

    var stencilDepthRenderState = {
        colorMask : {
            red : false,
            green : false,
            blue : false,
            alpha : false
        },
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.ALWAYS,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.INCREMENT_WRAP
            },
            backFunction : StencilFunction.ALWAYS,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            reference : 0,
            mask : ~0
        },
        depthTest : {
            enabled : true,
            func : DepthFunction.LESS_OR_EQUAL
        },
        depthMask : false
    };

    var colorRenderState = {
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.NOT_EQUAL,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            backFunction : StencilFunction.NOT_EQUAL,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            reference : 0,
            mask : ~0
        },
        depthTest : {
            enabled : false
        },
        depthMask : false,
        blending : BlendingState.ALPHA_BLEND
    };

    var pickRenderState = {
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.NOT_EQUAL,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            backFunction : StencilFunction.NOT_EQUAL,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            reference : 0,
            mask : ~0
        },
        depthTest : {
            enabled : false
        },
        depthMask : false
    };

    function createRenderStates(primitive) {
        if (defined(primitive._rsStencilPreloadPass)) {
            return;
        }

        primitive._rsStencilPreloadPass = RenderState.fromCache(stencilPreloadRenderState);
        primitive._rsStencilDepthPass = RenderState.fromCache(stencilDepthRenderState);
        primitive._rsColorPass = RenderState.fromCache(colorRenderState);
        primitive._rsPickPass = RenderState.fromCache(pickRenderState);
    }

    var modifiedModelViewScratch = new Matrix4();
    var rtcScratch = new Cartesian3();

    function createUniformMap(primitive, context) {
        if (defined(primitive._uniformMap)) {
            return;
        }

        primitive._uniformMap = {
            u_modifiedModelViewProjection : function() {
                var viewMatrix = context.uniformState.view;
                var projectionMatrix = context.uniformState.projection;
                Matrix4.clone(viewMatrix, modifiedModelViewScratch);
                Matrix4.multiplyByPoint(modifiedModelViewScratch, primitive._center, rtcScratch);
                Matrix4.setTranslation(modifiedModelViewScratch, rtcScratch, modifiedModelViewScratch);
                Matrix4.multiply(projectionMatrix, modifiedModelViewScratch, modifiedModelViewScratch);
                return modifiedModelViewScratch;
            }
        };
    }

    function createColorCommands(primitive) {
        if (defined(primitive._commands)) {
            return;
        }

        primitive._commands = [];

        var batchedIndices = primitive._batchedIndices;
        var length = batchedIndices.length;
        for (var i = 0; i < length; ++i) {
            var command = new DrawCommand({
                owner : primitive,
                primitiveType : PrimitiveType.TRIANGLES,
                vertexArray : primitive._va,
                shaderProgram : primitive._sp,
                uniformMap : primitive._uniformMap,
                modelMatrix : Matrix4.IDENTITY,
                boundingVolume : primitive._boundingVolume,
                pass : Pass.GROUND,
                offset : batchedIndices[i].offset,
                count : batchedIndices[i].count
            });

            var stencilPreloadCommand = command;
            var stencilDepthCommand = DrawCommand.shallowClone(command);
            var colorCommand = DrawCommand.shallowClone(command);

            stencilPreloadCommand.renderState = primitive._rsStencilPreloadPass;
            stencilDepthCommand.renderState = primitive._rsStencilDepthPass;
            colorCommand.renderState = primitive._rsColorPass;

            primitive._commands.push(stencilPreloadCommand, stencilDepthCommand, colorCommand);
        }
    }

    function createPickCommands(primitive) {
        if (defined(primitive._pickCommands)) {
            return;
        }

        primitive._pickCommands = [];

        var pickUniformMap = primitive._batchTableResources.getPickUniformMapCallback()(primitive._uniformMap);
        var offsets = primitive._indexOffsets;
        var counts = primitive._indexCounts;

        var length = offsets.length;
        for (var i = 0; i < length; ++i) {
            var command = new DrawCommand({
                owner : primitive,
                primitiveType : PrimitiveType.TRIANGLES,
                vertexArray : primitive._va,
                shaderProgram : primitive._spPick,
                uniformMap : pickUniformMap,
                modelMatrix : Matrix4.IDENTITY,
                boundingVolume : primitive._boundingVolumes[i],
                pass : Pass.GROUND,
                offset : offsets[i].offset,
                count : counts[i].count
            });

            var stencilPreloadCommand = command;
            var stencilDepthCommand = DrawCommand.shallowClone(command);
            var colorCommand = DrawCommand.shallowClone(command);

            stencilPreloadCommand.renderState = primitive._rsStencilPreloadPass;
            stencilDepthCommand.renderState = primitive._rsStencilDepthPass;
            colorCommand.renderState = primitive._rsColorPass;

            primitive._pickCommands.push(stencilPreloadCommand, stencilDepthCommand, colorCommand);
        }
    }

    Cesium3DTileGroundPrimitive.prototype.update = function(frameState) {
        var context = frameState.context;

        createVertexArray(this, context);
        createShaders(this, context);
        createRenderStates(this);
        createUniformMap(this, context);
        createColorCommands(this);

        var passes = frameState.passes;
        if (passes.render) {
            var commandLength = this._commands.length;
            for (var i = 0; i < commandLength; ++i) {
                frameState.commandList.push(this._commands[i]);
            }
        }

        if (passes.pick) {
            createPickCommands(this);
            var pickCommandLength = this._pickCommands.length;
            for (var j = 0; j < pickCommandLength; ++j) {
                frameState.commandList.push(this._pickCommands[j]);
            }
        }
    };

    Cesium3DTileGroundPrimitive.prototype.isDestroyed = function() {
        return false;
    };

    Cesium3DTileGroundPrimitive.prototype.destroy = function() {
        this._va = this._va && this._va.destroy();
        this._sp = this._sp && this._sp.destroy();
        return destroyObject(this);
    };

    return Cesium3DTileGroundPrimitive;
});