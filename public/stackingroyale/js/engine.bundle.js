"use strict";
var StackingRoyale = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // node_modules/tetris-fumen/lib/defines.js
  var require_defines = __commonJS({
    "node_modules/tetris-fumen/lib/defines.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.parseRotation = exports.parseRotationName = exports.Rotation = exports.parsePiece = exports.parsePieceName = exports.isMinoPiece = exports.Piece = void 0;
      var Piece;
      (function(Piece2) {
        Piece2[Piece2["Empty"] = 0] = "Empty";
        Piece2[Piece2["I"] = 1] = "I";
        Piece2[Piece2["L"] = 2] = "L";
        Piece2[Piece2["O"] = 3] = "O";
        Piece2[Piece2["Z"] = 4] = "Z";
        Piece2[Piece2["T"] = 5] = "T";
        Piece2[Piece2["J"] = 6] = "J";
        Piece2[Piece2["S"] = 7] = "S";
        Piece2[Piece2["Gray"] = 8] = "Gray";
      })(Piece = exports.Piece || (exports.Piece = {}));
      function isMinoPiece(piece) {
        return piece !== Piece.Empty && piece !== Piece.Gray;
      }
      exports.isMinoPiece = isMinoPiece;
      function parsePieceName(piece) {
        switch (piece) {
          case Piece.I:
            return "I";
          case Piece.L:
            return "L";
          case Piece.O:
            return "O";
          case Piece.Z:
            return "Z";
          case Piece.T:
            return "T";
          case Piece.J:
            return "J";
          case Piece.S:
            return "S";
          case Piece.Gray:
            return "X";
          case Piece.Empty:
            return "_";
        }
        throw new Error("Unknown piece: ".concat(piece));
      }
      exports.parsePieceName = parsePieceName;
      function parsePiece(piece) {
        switch (piece.toUpperCase()) {
          case "I":
            return Piece.I;
          case "L":
            return Piece.L;
          case "O":
            return Piece.O;
          case "Z":
            return Piece.Z;
          case "T":
            return Piece.T;
          case "J":
            return Piece.J;
          case "S":
            return Piece.S;
          case "X":
          case "GRAY":
            return Piece.Gray;
          case " ":
          case "_":
          case "EMPTY":
            return Piece.Empty;
        }
        throw new Error("Unknown piece: ".concat(piece));
      }
      exports.parsePiece = parsePiece;
      var Rotation;
      (function(Rotation2) {
        Rotation2[Rotation2["Spawn"] = 0] = "Spawn";
        Rotation2[Rotation2["Right"] = 1] = "Right";
        Rotation2[Rotation2["Reverse"] = 2] = "Reverse";
        Rotation2[Rotation2["Left"] = 3] = "Left";
      })(Rotation = exports.Rotation || (exports.Rotation = {}));
      function parseRotationName(rotation) {
        switch (rotation) {
          case Rotation.Spawn:
            return "spawn";
          case Rotation.Left:
            return "left";
          case Rotation.Right:
            return "right";
          case Rotation.Reverse:
            return "reverse";
        }
        throw new Error("Unknown rotation: ".concat(rotation));
      }
      exports.parseRotationName = parseRotationName;
      function parseRotation(rotation) {
        switch (rotation.toLowerCase()) {
          case "spawn":
            return Rotation.Spawn;
          case "left":
            return Rotation.Left;
          case "right":
            return Rotation.Right;
          case "reverse":
            return Rotation.Reverse;
        }
        throw new Error("Unknown rotation: ".concat(rotation));
      }
      exports.parseRotation = parseRotation;
    }
  });

  // node_modules/tetris-fumen/lib/inner_field.js
  var require_inner_field = __commonJS({
    "node_modules/tetris-fumen/lib/inner_field.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.getPieces = exports.getBlocks = exports.getBlockXYs = exports.getBlockPositions = exports.PlayField = exports.InnerField = exports.createInnerField = exports.createNewInnerField = void 0;
      var defines_1 = require_defines();
      var FieldConstants = {
        Width: 10,
        Height: 23,
        PlayBlocks: 23 * 10
        // Height * Width
      };
      function createNewInnerField() {
        return new InnerField({});
      }
      exports.createNewInnerField = createNewInnerField;
      function createInnerField(field) {
        var innerField = new InnerField({});
        for (var y = -1; y < FieldConstants.Height; y += 1) {
          for (var x = 0; x < FieldConstants.Width; x += 1) {
            var at = field.at(x, y);
            innerField.setNumberAt(x, y, (0, defines_1.parsePiece)(at));
          }
        }
        return innerField;
      }
      exports.createInnerField = createInnerField;
      var InnerField = (
        /** @class */
        (function() {
          function InnerField2(_a) {
            var _b = _a.field, field = _b === void 0 ? InnerField2.create(FieldConstants.PlayBlocks) : _b, _c = _a.garbage, garbage = _c === void 0 ? InnerField2.create(FieldConstants.Width) : _c;
            this.field = field;
            this.garbage = garbage;
          }
          InnerField2.create = function(length) {
            return new PlayField({ length });
          };
          InnerField2.prototype.fill = function(operation) {
            this.field.fill(operation);
          };
          InnerField2.prototype.fillAll = function(positions, type) {
            this.field.fillAll(positions, type);
          };
          InnerField2.prototype.canFill = function(piece, rotation, x, y) {
            var _this = this;
            var positions = getBlockPositions(piece, rotation, x, y);
            return positions.every(function(_a) {
              var px = _a[0], py = _a[1];
              return 0 <= px && px < 10 && 0 <= py && py < FieldConstants.Height && _this.getNumberAt(px, py) === defines_1.Piece.Empty;
            });
          };
          InnerField2.prototype.canFillAll = function(positions) {
            var _this = this;
            return positions.every(function(_a) {
              var x = _a.x, y = _a.y;
              return 0 <= x && x < 10 && 0 <= y && y < FieldConstants.Height && _this.getNumberAt(x, y) === defines_1.Piece.Empty;
            });
          };
          InnerField2.prototype.isOnGround = function(piece, rotation, x, y) {
            return !this.canFill(piece, rotation, x, y - 1);
          };
          InnerField2.prototype.clearLine = function() {
            this.field.clearLine();
          };
          InnerField2.prototype.riseGarbage = function() {
            this.field.up(this.garbage);
            this.garbage.clearAll();
          };
          InnerField2.prototype.mirror = function() {
            this.field.mirror();
          };
          InnerField2.prototype.shiftToLeft = function() {
            this.field.shiftToLeft();
          };
          InnerField2.prototype.shiftToRight = function() {
            this.field.shiftToRight();
          };
          InnerField2.prototype.shiftToUp = function() {
            this.field.shiftToUp();
          };
          InnerField2.prototype.shiftToBottom = function() {
            this.field.shiftToBottom();
          };
          InnerField2.prototype.copy = function() {
            return new InnerField2({ field: this.field.copy(), garbage: this.garbage.copy() });
          };
          InnerField2.prototype.equals = function(other) {
            return this.field.equals(other.field) && this.garbage.equals(other.garbage);
          };
          InnerField2.prototype.addNumber = function(x, y, value) {
            if (0 <= y) {
              this.field.addOffset(x, y, value);
            } else {
              this.garbage.addOffset(x, -(y + 1), value);
            }
          };
          InnerField2.prototype.setNumberFieldAt = function(index, value) {
            this.field.setAt(index, value);
          };
          InnerField2.prototype.setNumberGarbageAt = function(index, value) {
            this.garbage.setAt(index, value);
          };
          InnerField2.prototype.setNumberAt = function(x, y, value) {
            return 0 <= y ? this.field.set(x, y, value) : this.garbage.set(x, -(y + 1), value);
          };
          InnerField2.prototype.getNumberAt = function(x, y) {
            return 0 <= y ? this.field.get(x, y) : this.garbage.get(x, -(y + 1));
          };
          InnerField2.prototype.getNumberAtIndex = function(index, isField) {
            if (isField) {
              return this.getNumberAt(index % 10, Math.floor(index / 10));
            }
            return this.getNumberAt(index % 10, -(Math.floor(index / 10) + 1));
          };
          InnerField2.prototype.toFieldNumberArray = function() {
            return this.field.toArray();
          };
          InnerField2.prototype.toGarbageNumberArray = function() {
            return this.garbage.toArray();
          };
          return InnerField2;
        })()
      );
      exports.InnerField = InnerField;
      var PlayField = (
        /** @class */
        (function() {
          function PlayField2(_a) {
            var pieces = _a.pieces, _b = _a.length, length = _b === void 0 ? FieldConstants.PlayBlocks : _b;
            if (pieces !== void 0) {
              this.pieces = pieces;
            } else {
              this.pieces = Array.from({ length }).map(function() {
                return defines_1.Piece.Empty;
              });
            }
            this.length = length;
          }
          PlayField2.load = function() {
            var lines = [];
            for (var _i = 0; _i < arguments.length; _i++) {
              lines[_i] = arguments[_i];
            }
            var blocks = lines.join("").trim();
            return PlayField2.loadInner(blocks);
          };
          PlayField2.loadMinify = function() {
            var lines = [];
            for (var _i = 0; _i < arguments.length; _i++) {
              lines[_i] = arguments[_i];
            }
            var blocks = lines.join("").trim();
            return PlayField2.loadInner(blocks, blocks.length);
          };
          PlayField2.loadInner = function(blocks, length) {
            var len = length !== void 0 ? length : blocks.length;
            if (len % 10 !== 0) {
              throw new Error("Num of blocks in field should be mod 10");
            }
            var field = length !== void 0 ? new PlayField2({ length }) : new PlayField2({});
            for (var index = 0; index < len; index += 1) {
              var block = blocks[index];
              field.set(index % 10, Math.floor((len - index - 1) / 10), (0, defines_1.parsePiece)(block));
            }
            return field;
          };
          PlayField2.prototype.get = function(x, y) {
            return this.pieces[x + y * FieldConstants.Width];
          };
          PlayField2.prototype.addOffset = function(x, y, value) {
            this.pieces[x + y * FieldConstants.Width] += value;
          };
          PlayField2.prototype.set = function(x, y, piece) {
            this.setAt(x + y * FieldConstants.Width, piece);
          };
          PlayField2.prototype.setAt = function(index, piece) {
            this.pieces[index] = piece;
          };
          PlayField2.prototype.fill = function(_a) {
            var type = _a.type, rotation = _a.rotation, x = _a.x, y = _a.y;
            var blocks = getBlocks(type, rotation);
            for (var _i = 0, blocks_1 = blocks; _i < blocks_1.length; _i++) {
              var block = blocks_1[_i];
              var _b = [x + block[0], y + block[1]], nx = _b[0], ny = _b[1];
              this.set(nx, ny, type);
            }
          };
          PlayField2.prototype.fillAll = function(positions, type) {
            for (var _i = 0, positions_1 = positions; _i < positions_1.length; _i++) {
              var _a = positions_1[_i], x = _a.x, y = _a.y;
              this.set(x, y, type);
            }
          };
          PlayField2.prototype.clearLine = function() {
            var newField = this.pieces.concat();
            var top = this.pieces.length / FieldConstants.Width - 1;
            for (var y = top; 0 <= y; y -= 1) {
              var line = this.pieces.slice(y * FieldConstants.Width, (y + 1) * FieldConstants.Width);
              var isFilled = line.every(function(value) {
                return value !== defines_1.Piece.Empty;
              });
              if (isFilled) {
                var bottom = newField.slice(0, y * FieldConstants.Width);
                var over = newField.slice((y + 1) * FieldConstants.Width);
                newField = bottom.concat(over, Array.from({ length: FieldConstants.Width }).map(function() {
                  return defines_1.Piece.Empty;
                }));
              }
            }
            this.pieces = newField;
          };
          PlayField2.prototype.up = function(blockUp) {
            this.pieces = blockUp.pieces.concat(this.pieces).slice(0, this.length);
          };
          PlayField2.prototype.mirror = function() {
            var newField = [];
            for (var y = 0; y < this.pieces.length; y += 1) {
              var line = this.pieces.slice(y * FieldConstants.Width, (y + 1) * FieldConstants.Width);
              line.reverse();
              for (var _i = 0, line_1 = line; _i < line_1.length; _i++) {
                var obj = line_1[_i];
                newField.push(obj);
              }
            }
            this.pieces = newField;
          };
          PlayField2.prototype.shiftToLeft = function() {
            var height = this.pieces.length / 10;
            for (var y = 0; y < height; y += 1) {
              for (var x = 0; x < FieldConstants.Width - 1; x += 1) {
                this.pieces[x + y * FieldConstants.Width] = this.pieces[x + 1 + y * FieldConstants.Width];
              }
              this.pieces[9 + y * FieldConstants.Width] = defines_1.Piece.Empty;
            }
          };
          PlayField2.prototype.shiftToRight = function() {
            var height = this.pieces.length / 10;
            for (var y = 0; y < height; y += 1) {
              for (var x = FieldConstants.Width - 1; 1 <= x; x -= 1) {
                this.pieces[x + y * FieldConstants.Width] = this.pieces[x - 1 + y * FieldConstants.Width];
              }
              this.pieces[y * FieldConstants.Width] = defines_1.Piece.Empty;
            }
          };
          PlayField2.prototype.shiftToUp = function() {
            var blanks = Array.from({ length: 10 }).map(function() {
              return defines_1.Piece.Empty;
            });
            this.pieces = blanks.concat(this.pieces).slice(0, this.length);
          };
          PlayField2.prototype.shiftToBottom = function() {
            var blanks = Array.from({ length: 10 }).map(function() {
              return defines_1.Piece.Empty;
            });
            this.pieces = this.pieces.slice(10, this.length).concat(blanks);
          };
          PlayField2.prototype.toArray = function() {
            return this.pieces.concat();
          };
          Object.defineProperty(PlayField2.prototype, "numOfBlocks", {
            get: function() {
              return this.pieces.length;
            },
            enumerable: false,
            configurable: true
          });
          PlayField2.prototype.copy = function() {
            return new PlayField2({ pieces: this.pieces.concat(), length: this.length });
          };
          PlayField2.prototype.toShallowArray = function() {
            return this.pieces;
          };
          PlayField2.prototype.clearAll = function() {
            this.pieces = this.pieces.map(function() {
              return defines_1.Piece.Empty;
            });
          };
          PlayField2.prototype.equals = function(other) {
            if (this.pieces.length !== other.pieces.length) {
              return false;
            }
            for (var index = 0; index < this.pieces.length; index += 1) {
              if (this.pieces[index] !== other.pieces[index]) {
                return false;
              }
            }
            return true;
          };
          return PlayField2;
        })()
      );
      exports.PlayField = PlayField;
      function getBlockPositions(piece, rotation, x, y) {
        return getBlocks(piece, rotation).map(function(position) {
          position[0] += x;
          position[1] += y;
          return position;
        });
      }
      exports.getBlockPositions = getBlockPositions;
      function getBlockXYs(piece, rotation, x, y) {
        return getBlocks(piece, rotation).map(function(position) {
          return { x: position[0] + x, y: position[1] + y };
        });
      }
      exports.getBlockXYs = getBlockXYs;
      function getBlocks(piece, rotation) {
        var blocks = getPieces(piece);
        switch (rotation) {
          case defines_1.Rotation.Spawn:
            return blocks;
          case defines_1.Rotation.Left:
            return rotateLeft(blocks);
          case defines_1.Rotation.Reverse:
            return rotateReverse(blocks);
          case defines_1.Rotation.Right:
            return rotateRight(blocks);
        }
        throw new Error("Unsupported block");
      }
      exports.getBlocks = getBlocks;
      function getPieces(piece) {
        switch (piece) {
          case defines_1.Piece.I:
            return [[0, 0], [-1, 0], [1, 0], [2, 0]];
          case defines_1.Piece.T:
            return [[0, 0], [-1, 0], [1, 0], [0, 1]];
          case defines_1.Piece.O:
            return [[0, 0], [1, 0], [0, 1], [1, 1]];
          case defines_1.Piece.L:
            return [[0, 0], [-1, 0], [1, 0], [1, 1]];
          case defines_1.Piece.J:
            return [[0, 0], [-1, 0], [1, 0], [-1, 1]];
          case defines_1.Piece.S:
            return [[0, 0], [-1, 0], [0, 1], [1, 1]];
          case defines_1.Piece.Z:
            return [[0, 0], [1, 0], [0, 1], [-1, 1]];
        }
        throw new Error("Unsupported rotation");
      }
      exports.getPieces = getPieces;
      function rotateRight(positions) {
        return positions.map(function(current) {
          return [current[1], -current[0]];
        });
      }
      function rotateLeft(positions) {
        return positions.map(function(current) {
          return [-current[1], current[0]];
        });
      }
      function rotateReverse(positions) {
        return positions.map(function(current) {
          return [-current[0], -current[1]];
        });
      }
    }
  });

  // node_modules/tetris-fumen/lib/buffer.js
  var require_buffer = __commonJS({
    "node_modules/tetris-fumen/lib/buffer.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Buffer = void 0;
      var ENCODE_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      var Buffer2 = (
        /** @class */
        (function() {
          function Buffer3(data) {
            if (data === void 0) {
              data = "";
            }
            this.values = data.split("").map(decodeToValue);
          }
          Buffer3.prototype.poll = function(max) {
            var value = 0;
            for (var count = 0; count < max; count += 1) {
              var v = this.values.shift();
              if (v === void 0) {
                throw new Error("Unexpected fumen");
              }
              value += v * Math.pow(Buffer3.tableLength, count);
            }
            return value;
          };
          Buffer3.prototype.push = function(value, splitCount) {
            if (splitCount === void 0) {
              splitCount = 1;
            }
            var current = value;
            for (var count = 0; count < splitCount; count += 1) {
              this.values.push(current % Buffer3.tableLength);
              current = Math.floor(current / Buffer3.tableLength);
            }
          };
          Buffer3.prototype.merge = function(postBuffer) {
            for (var _i = 0, _a = postBuffer.values; _i < _a.length; _i++) {
              var value = _a[_i];
              this.values.push(value);
            }
          };
          Buffer3.prototype.isEmpty = function() {
            return this.values.length === 0;
          };
          Object.defineProperty(Buffer3.prototype, "length", {
            get: function() {
              return this.values.length;
            },
            enumerable: false,
            configurable: true
          });
          Buffer3.prototype.get = function(index) {
            return this.values[index];
          };
          Buffer3.prototype.set = function(index, value) {
            this.values[index] = value;
          };
          Buffer3.prototype.toString = function() {
            return this.values.map(encodeFromValue).join("");
          };
          Buffer3.tableLength = ENCODE_TABLE.length;
          return Buffer3;
        })()
      );
      exports.Buffer = Buffer2;
      function decodeToValue(v) {
        return ENCODE_TABLE.indexOf(v);
      }
      function encodeFromValue(index) {
        return ENCODE_TABLE[index];
      }
    }
  });

  // node_modules/tetris-fumen/lib/action.js
  var require_action = __commonJS({
    "node_modules/tetris-fumen/lib/action.js"(exports) {
      "use strict";
      var __assign = exports && exports.__assign || function() {
        __assign = Object.assign || function(t) {
          for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
              t[p] = s[p];
          }
          return t;
        };
        return __assign.apply(this, arguments);
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.createActionEncoder = exports.createActionDecoder = void 0;
      var defines_1 = require_defines();
      function decodeBool(n) {
        return n !== 0;
      }
      var createActionDecoder = function(width, fieldTop, garbageLine) {
        var fieldMaxHeight = fieldTop + garbageLine;
        var numFieldBlocks = fieldMaxHeight * width;
        function decodePiece(n) {
          switch (n) {
            case 0:
              return defines_1.Piece.Empty;
            case 1:
              return defines_1.Piece.I;
            case 2:
              return defines_1.Piece.L;
            case 3:
              return defines_1.Piece.O;
            case 4:
              return defines_1.Piece.Z;
            case 5:
              return defines_1.Piece.T;
            case 6:
              return defines_1.Piece.J;
            case 7:
              return defines_1.Piece.S;
            case 8:
              return defines_1.Piece.Gray;
          }
          throw new Error("Unexpected piece");
        }
        function decodeRotation(n) {
          switch (n) {
            case 0:
              return defines_1.Rotation.Reverse;
            case 1:
              return defines_1.Rotation.Right;
            case 2:
              return defines_1.Rotation.Spawn;
            case 3:
              return defines_1.Rotation.Left;
          }
          throw new Error("Unexpected rotation");
        }
        function decodeCoordinate(n, piece, rotation) {
          var x = n % width;
          var originY = Math.floor(n / 10);
          var y = fieldTop - originY - 1;
          if (piece === defines_1.Piece.O && rotation === defines_1.Rotation.Left) {
            x += 1;
            y -= 1;
          } else if (piece === defines_1.Piece.O && rotation === defines_1.Rotation.Reverse) {
            x += 1;
          } else if (piece === defines_1.Piece.O && rotation === defines_1.Rotation.Spawn) {
            y -= 1;
          } else if (piece === defines_1.Piece.I && rotation === defines_1.Rotation.Reverse) {
            x += 1;
          } else if (piece === defines_1.Piece.I && rotation === defines_1.Rotation.Left) {
            y -= 1;
          } else if (piece === defines_1.Piece.S && rotation === defines_1.Rotation.Spawn) {
            y -= 1;
          } else if (piece === defines_1.Piece.S && rotation === defines_1.Rotation.Right) {
            x -= 1;
          } else if (piece === defines_1.Piece.Z && rotation === defines_1.Rotation.Spawn) {
            y -= 1;
          } else if (piece === defines_1.Piece.Z && rotation === defines_1.Rotation.Left) {
            x += 1;
          }
          return { x, y };
        }
        return {
          decode: function(v) {
            var value = v;
            var type = decodePiece(value % 8);
            value = Math.floor(value / 8);
            var rotation = decodeRotation(value % 4);
            value = Math.floor(value / 4);
            var coordinate = decodeCoordinate(value % numFieldBlocks, type, rotation);
            value = Math.floor(value / numFieldBlocks);
            var isBlockUp = decodeBool(value % 2);
            value = Math.floor(value / 2);
            var isMirror = decodeBool(value % 2);
            value = Math.floor(value / 2);
            var isColor = decodeBool(value % 2);
            value = Math.floor(value / 2);
            var isComment = decodeBool(value % 2);
            value = Math.floor(value / 2);
            var isLock = !decodeBool(value % 2);
            return {
              rise: isBlockUp,
              mirror: isMirror,
              colorize: isColor,
              comment: isComment,
              lock: isLock,
              piece: __assign(__assign({}, coordinate), { type, rotation })
            };
          }
        };
      };
      exports.createActionDecoder = createActionDecoder;
      function encodeBool(flag) {
        return flag ? 1 : 0;
      }
      var createActionEncoder = function(width, fieldTop, garbageLine) {
        var fieldMaxHeight = fieldTop + garbageLine;
        var numFieldBlocks = fieldMaxHeight * width;
        function encodePosition(operation) {
          var type = operation.type, rotation = operation.rotation;
          var x = operation.x;
          var y = operation.y;
          if (!(0, defines_1.isMinoPiece)(type)) {
            x = 0;
            y = 22;
          } else if (type === defines_1.Piece.O && rotation === defines_1.Rotation.Left) {
            x -= 1;
            y += 1;
          } else if (type === defines_1.Piece.O && rotation === defines_1.Rotation.Reverse) {
            x -= 1;
          } else if (type === defines_1.Piece.O && rotation === defines_1.Rotation.Spawn) {
            y += 1;
          } else if (type === defines_1.Piece.I && rotation === defines_1.Rotation.Reverse) {
            x -= 1;
          } else if (type === defines_1.Piece.I && rotation === defines_1.Rotation.Left) {
            y += 1;
          } else if (type === defines_1.Piece.S && rotation === defines_1.Rotation.Spawn) {
            y += 1;
          } else if (type === defines_1.Piece.S && rotation === defines_1.Rotation.Right) {
            x += 1;
          } else if (type === defines_1.Piece.Z && rotation === defines_1.Rotation.Spawn) {
            y += 1;
          } else if (type === defines_1.Piece.Z && rotation === defines_1.Rotation.Left) {
            x -= 1;
          }
          return (fieldTop - y - 1) * width + x;
        }
        function encodeRotation(_a) {
          var type = _a.type, rotation = _a.rotation;
          if (!(0, defines_1.isMinoPiece)(type)) {
            return 0;
          }
          switch (rotation) {
            case defines_1.Rotation.Reverse:
              return 0;
            case defines_1.Rotation.Right:
              return 1;
            case defines_1.Rotation.Spawn:
              return 2;
            case defines_1.Rotation.Left:
              return 3;
          }
          throw new Error("No reachable");
        }
        return {
          encode: function(action) {
            var lock = action.lock, comment = action.comment, colorize = action.colorize, mirror = action.mirror, rise = action.rise, piece = action.piece;
            var value = encodeBool(!lock);
            value *= 2;
            value += encodeBool(comment);
            value *= 2;
            value += encodeBool(colorize);
            value *= 2;
            value += encodeBool(mirror);
            value *= 2;
            value += encodeBool(rise);
            value *= numFieldBlocks;
            value += encodePosition(piece);
            value *= 4;
            value += encodeRotation(piece);
            value *= 8;
            value += piece.type;
            return value;
          }
        };
      };
      exports.createActionEncoder = createActionEncoder;
    }
  });

  // node_modules/tetris-fumen/lib/comments.js
  var require_comments = __commonJS({
    "node_modules/tetris-fumen/lib/comments.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.createCommentParser = void 0;
      var COMMENT_TABLE = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
      var MAX_COMMENT_CHAR_VALUE = COMMENT_TABLE.length + 1;
      var createCommentParser = function() {
        return {
          decode: function(v) {
            var str = "";
            var value = v;
            for (var count = 0; count < 4; count += 1) {
              var index = value % MAX_COMMENT_CHAR_VALUE;
              str += COMMENT_TABLE[index];
              value = Math.floor(value / MAX_COMMENT_CHAR_VALUE);
            }
            return str;
          },
          encode: function(ch, count) {
            return COMMENT_TABLE.indexOf(ch) * Math.pow(MAX_COMMENT_CHAR_VALUE, count);
          }
        };
      };
      exports.createCommentParser = createCommentParser;
    }
  });

  // node_modules/tetris-fumen/lib/quiz.js
  var require_quiz = __commonJS({
    "node_modules/tetris-fumen/lib/quiz.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Quiz = void 0;
      var defines_1 = require_defines();
      var Operation;
      (function(Operation2) {
        Operation2["Direct"] = "direct";
        Operation2["Swap"] = "swap";
        Operation2["Stock"] = "stock";
      })(Operation || (Operation = {}));
      var Quiz = (
        /** @class */
        (function() {
          function Quiz2(quiz) {
            this.quiz = Quiz2.verify(quiz);
          }
          Object.defineProperty(Quiz2.prototype, "next", {
            get: function() {
              var index = this.quiz.indexOf(")") + 1;
              var name = this.quiz[index];
              if (name === void 0 || name === ";") {
                return "";
              }
              return name;
            },
            enumerable: false,
            configurable: true
          });
          Quiz2.isQuizComment = function(comment) {
            return comment.startsWith("#Q=");
          };
          Quiz2.create = function(first, second) {
            var create = function(hold, other) {
              var parse = function(s) {
                return s ? s : "";
              };
              return new Quiz2("#Q=[".concat(parse(hold), "](").concat(parse(other[0]), ")").concat(parse(other.substring(1))));
            };
            return second !== void 0 ? create(first, second) : create(void 0, first);
          };
          Quiz2.trim = function(quiz) {
            return quiz.trim().replace(/\s+/g, "");
          };
          Object.defineProperty(Quiz2.prototype, "least", {
            get: function() {
              var index = this.quiz.indexOf(")");
              return this.quiz.substr(index + 1);
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Quiz2.prototype, "current", {
            get: function() {
              var index = this.quiz.indexOf("(") + 1;
              var name = this.quiz[index];
              if (name === ")") {
                return "";
              }
              return name;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Quiz2.prototype, "hold", {
            get: function() {
              var index = this.quiz.indexOf("[") + 1;
              var name = this.quiz[index];
              if (name === "]") {
                return "";
              }
              return name;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Quiz2.prototype, "leastAfterNext2", {
            get: function() {
              var index = this.quiz.indexOf(")");
              if (this.quiz[index + 1] === ";") {
                return this.quiz.substr(index + 1);
              }
              return this.quiz.substr(index + 2);
            },
            enumerable: false,
            configurable: true
          });
          Quiz2.prototype.getOperation = function(used) {
            var usedName = (0, defines_1.parsePieceName)(used);
            var current = this.current;
            if (usedName === current) {
              return Operation.Direct;
            }
            var hold = this.hold;
            if (usedName === hold) {
              return Operation.Swap;
            }
            if (hold === "") {
              if (usedName === this.next) {
                return Operation.Stock;
              }
            } else {
              if (current === "" && usedName === this.next) {
                return Operation.Direct;
              }
            }
            throw new Error("Unexpected hold piece in quiz: ".concat(this.quiz));
          };
          Object.defineProperty(Quiz2.prototype, "leastInActiveBag", {
            get: function() {
              var separateIndex = this.quiz.indexOf(";");
              var quiz = 0 <= separateIndex ? this.quiz.substring(0, separateIndex) : this.quiz;
              var index = quiz.indexOf(")");
              if (quiz[index + 1] === ";") {
                return quiz.substr(index + 1);
              }
              return quiz.substr(index + 2);
            },
            enumerable: false,
            configurable: true
          });
          Quiz2.verify = function(quiz) {
            var replaced = this.trim(quiz);
            if (replaced.length === 0 || quiz === "#Q=[]()" || !quiz.startsWith("#Q=")) {
              return quiz;
            }
            if (!replaced.match(/^#Q=\[[TIOSZJL]?]\([TIOSZJL]?\)[TIOSZJL]*;?.*$/i)) {
              throw new Error("Current piece doesn't exist, however next pieces exist: ".concat(quiz));
            }
            return replaced;
          };
          Quiz2.prototype.direct = function() {
            if (this.current === "") {
              var least = this.leastAfterNext2;
              return new Quiz2("#Q=[".concat(this.hold, "](").concat(least[0], ")").concat(least.substr(1)));
            }
            return new Quiz2("#Q=[".concat(this.hold, "](").concat(this.next, ")").concat(this.leastAfterNext2));
          };
          Quiz2.prototype.swap = function() {
            if (this.hold === "") {
              throw new Error("Cannot find hold piece: ".concat(this.quiz));
            }
            var next = this.next;
            return new Quiz2("#Q=[".concat(this.current, "](").concat(next, ")").concat(this.leastAfterNext2));
          };
          Quiz2.prototype.stock = function() {
            if (this.hold !== "" || this.next === "") {
              throw new Error("Cannot stock: ".concat(this.quiz));
            }
            var least = this.leastAfterNext2;
            var head = least[0] !== void 0 ? least[0] : "";
            if (1 < least.length) {
              return new Quiz2("#Q=[".concat(this.current, "](").concat(head, ")").concat(least.substr(1)));
            }
            return new Quiz2("#Q=[".concat(this.current, "](").concat(head, ")"));
          };
          Quiz2.prototype.operate = function(operation) {
            switch (operation) {
              case Operation.Direct:
                return this.direct();
              case Operation.Swap:
                return this.swap();
              case Operation.Stock:
                return this.stock();
            }
            throw new Error("Unexpected operation");
          };
          Quiz2.prototype.format = function() {
            var quiz = this.nextIfEnd();
            if (quiz.quiz === "#Q=[]()") {
              return new Quiz2("");
            }
            var current = quiz.current;
            var hold = quiz.hold;
            if (current === "" && hold !== "") {
              return new Quiz2("#Q=[](".concat(hold, ")").concat(quiz.least));
            }
            if (current === "") {
              var least = quiz.least;
              var head = least[0];
              if (head === void 0) {
                return new Quiz2("");
              }
              if (head === ";") {
                return new Quiz2(least.substr(1));
              }
              return new Quiz2("#Q=[](".concat(head, ")").concat(least.substr(1)));
            }
            return quiz;
          };
          Quiz2.prototype.getHoldPiece = function() {
            if (!this.canOperate()) {
              return defines_1.Piece.Empty;
            }
            var name = this.hold;
            if (name === void 0 || name === "" || name === ";") {
              return defines_1.Piece.Empty;
            }
            return (0, defines_1.parsePiece)(name);
          };
          Quiz2.prototype.getNextPieces = function(max) {
            if (!this.canOperate()) {
              return max !== void 0 ? Array.from({ length: max }).map(function() {
                return defines_1.Piece.Empty;
              }) : [];
            }
            var names = (this.current + this.next + this.leastInActiveBag).substr(0, max);
            if (max !== void 0 && names.length < max) {
              names += " ".repeat(max - names.length);
            }
            return names.split("").map(function(name) {
              if (name === void 0 || name === " " || name === ";") {
                return defines_1.Piece.Empty;
              }
              return (0, defines_1.parsePiece)(name);
            });
          };
          Quiz2.prototype.toString = function() {
            return this.quiz;
          };
          Quiz2.prototype.canOperate = function() {
            var quiz = this.quiz;
            if (quiz.startsWith("#Q=[]();")) {
              quiz = this.quiz.substr(8);
            }
            return quiz.startsWith("#Q=") && quiz !== "#Q=[]()";
          };
          Quiz2.prototype.nextIfEnd = function() {
            if (this.quiz.startsWith("#Q=[]();")) {
              return new Quiz2(this.quiz.substr(8));
            }
            return this;
          };
          return Quiz2;
        })()
      );
      exports.Quiz = Quiz;
    }
  });

  // node_modules/tetris-fumen/lib/field.js
  var require_field = __commonJS({
    "node_modules/tetris-fumen/lib/field.js"(exports) {
      "use strict";
      var __assign = exports && exports.__assign || function() {
        __assign = Object.assign || function(t) {
          for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
              t[p] = s[p];
          }
          return t;
        };
        return __assign.apply(this, arguments);
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.Mino = exports.Field = void 0;
      var inner_field_1 = require_inner_field();
      var defines_1 = require_defines();
      function toMino(operationOrMino) {
        return operationOrMino instanceof Mino ? operationOrMino.copy() : Mino.from(operationOrMino);
      }
      var Field = (
        /** @class */
        (function() {
          function Field2(field) {
            this.field = field;
          }
          Field2.create = function(field, garbage) {
            return new Field2(new inner_field_1.InnerField({
              field: field !== void 0 ? inner_field_1.PlayField.load(field) : void 0,
              garbage: garbage !== void 0 ? inner_field_1.PlayField.loadMinify(garbage) : void 0
            }));
          };
          Field2.prototype.canFill = function(operation) {
            if (operation === void 0) {
              return true;
            }
            var mino = toMino(operation);
            return this.field.canFillAll(mino.positions());
          };
          Field2.prototype.canLock = function(operation) {
            if (operation === void 0) {
              return true;
            }
            if (!this.canFill(operation)) {
              return false;
            }
            return !this.canFill(__assign(__assign({}, operation), { y: operation.y - 1 }));
          };
          Field2.prototype.fill = function(operation, force) {
            if (force === void 0) {
              force = false;
            }
            if (operation === void 0) {
              return void 0;
            }
            var mino = toMino(operation);
            if (!force && !this.canFill(mino)) {
              throw Error("Cannot fill piece on field");
            }
            this.field.fillAll(mino.positions(), (0, defines_1.parsePiece)(mino.type));
            return mino;
          };
          Field2.prototype.put = function(operation) {
            if (operation === void 0) {
              return void 0;
            }
            var mino = toMino(operation);
            for (; 0 <= mino.y; mino.y -= 1) {
              if (!this.canLock(mino)) {
                continue;
              }
              this.fill(mino);
              return mino;
            }
            throw Error("Cannot put piece on field");
          };
          Field2.prototype.clearLine = function() {
            this.field.clearLine();
          };
          Field2.prototype.at = function(x, y) {
            return (0, defines_1.parsePieceName)(this.field.getNumberAt(x, y));
          };
          Field2.prototype.set = function(x, y, type) {
            this.field.setNumberAt(x, y, (0, defines_1.parsePiece)(type));
          };
          Field2.prototype.copy = function() {
            return new Field2(this.field.copy());
          };
          Field2.prototype.str = function(option) {
            if (option === void 0) {
              option = {};
            }
            var skip = option.reduced !== void 0 ? option.reduced : true;
            var separator = option.separator !== void 0 ? option.separator : "\n";
            var minY = option.garbage === void 0 || option.garbage ? -1 : 0;
            var output = "";
            for (var y = 22; minY <= y; y -= 1) {
              var line = "";
              for (var x = 0; x < 10; x += 1) {
                line += this.at(x, y);
              }
              if (skip && line === "__________") {
                continue;
              }
              skip = false;
              output += line;
              if (y !== minY) {
                output += separator;
              }
            }
            return output;
          };
          return Field2;
        })()
      );
      exports.Field = Field;
      var Mino = (
        /** @class */
        (function() {
          function Mino2(type, rotation, x, y) {
            this.type = type;
            this.rotation = rotation;
            this.x = x;
            this.y = y;
          }
          Mino2.from = function(operation) {
            return new Mino2(operation.type, operation.rotation, operation.x, operation.y);
          };
          Mino2.prototype.positions = function() {
            return (0, inner_field_1.getBlockXYs)((0, defines_1.parsePiece)(this.type), (0, defines_1.parseRotation)(this.rotation), this.x, this.y).sort(function(a, b) {
              if (a.y === b.y) {
                return a.x - b.x;
              }
              return a.y - b.y;
            });
          };
          Mino2.prototype.operation = function() {
            return {
              type: this.type,
              rotation: this.rotation,
              x: this.x,
              y: this.y
            };
          };
          Mino2.prototype.isValid = function() {
            try {
              (0, defines_1.parsePiece)(this.type);
              (0, defines_1.parseRotation)(this.rotation);
            } catch (e) {
              return false;
            }
            return this.positions().every(function(_a) {
              var x = _a.x, y = _a.y;
              return 0 <= x && x < 10 && 0 <= y && y < 23;
            });
          };
          Mino2.prototype.copy = function() {
            return new Mino2(this.type, this.rotation, this.x, this.y);
          };
          return Mino2;
        })()
      );
      exports.Mino = Mino;
    }
  });

  // node_modules/tetris-fumen/lib/decoder.js
  var require_decoder = __commonJS({
    "node_modules/tetris-fumen/lib/decoder.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.decode = exports.extract = exports.Page = void 0;
      var inner_field_1 = require_inner_field();
      var buffer_1 = require_buffer();
      var defines_1 = require_defines();
      var action_1 = require_action();
      var comments_1 = require_comments();
      var quiz_1 = require_quiz();
      var field_1 = require_field();
      var Page = (
        /** @class */
        (function() {
          function Page2(index, field, operation, comment, flags, refs) {
            this.index = index;
            this.operation = operation;
            this.comment = comment;
            this.flags = flags;
            this.refs = refs;
            this._field = field.copy();
          }
          Object.defineProperty(Page2.prototype, "field", {
            get: function() {
              return new field_1.Field(this._field.copy());
            },
            set: function(field) {
              this._field = (0, inner_field_1.createInnerField)(field);
            },
            enumerable: false,
            configurable: true
          });
          Page2.prototype.mino = function() {
            return field_1.Mino.from(this.operation);
          };
          return Page2;
        })()
      );
      exports.Page = Page;
      var FieldConstants = {
        GarbageLine: 1,
        Width: 10
      };
      function extract(str) {
        var format = function(version, data2) {
          var trim = data2.trim().replace(/[?\s]+/g, "");
          return { version, data: trim };
        };
        var data = str;
        var paramIndex = data.indexOf("&");
        if (0 <= paramIndex) {
          data = data.substring(0, paramIndex);
        }
        {
          var match = str.match(/[vmd]115@/);
          if (match !== void 0 && match !== null && match.index !== void 0) {
            var sub = data.substr(match.index + 5);
            return format("115", sub);
          }
        }
        {
          var match = str.match(/[vmd]110@/);
          if (match !== void 0 && match !== null && match.index !== void 0) {
            var sub = data.substr(match.index + 5);
            return format("110", sub);
          }
        }
        throw new Error("Unsupported fumen version");
      }
      exports.extract = extract;
      function decode(fumen) {
        var _a = extract(fumen), version = _a.version, data = _a.data;
        switch (version) {
          case "115":
            return innerDecode(data, 23);
          case "110":
            return innerDecode(data, 21);
        }
        throw new Error("Unsupported fumen version");
      }
      exports.decode = decode;
      function innerDecode(data, fieldTop) {
        var fieldMaxHeight = fieldTop + FieldConstants.GarbageLine;
        var numFieldBlocks = fieldMaxHeight * FieldConstants.Width;
        var buffer = new buffer_1.Buffer(data);
        var updateField = function(prev) {
          var result = {
            changed: true,
            field: prev
          };
          var index = 0;
          while (index < numFieldBlocks) {
            var diffBlock = buffer.poll(2);
            var diff = Math.floor(diffBlock / numFieldBlocks);
            var numOfBlocks = diffBlock % numFieldBlocks;
            if (diff === 8 && numOfBlocks === numFieldBlocks - 1) {
              result.changed = false;
            }
            for (var block = 0; block < numOfBlocks + 1; block += 1) {
              var x = index % FieldConstants.Width;
              var y = fieldTop - Math.floor(index / FieldConstants.Width) - 1;
              result.field.addNumber(x, y, diff - 8);
              index += 1;
            }
          }
          return result;
        };
        var pageIndex = 0;
        var prevField = (0, inner_field_1.createNewInnerField)();
        var store = {
          repeatCount: -1,
          refIndex: {
            comment: 0,
            field: 0
          },
          quiz: void 0,
          lastCommentText: ""
        };
        var pages = [];
        var actionDecoder = (0, action_1.createActionDecoder)(FieldConstants.Width, fieldTop, FieldConstants.GarbageLine);
        var commentDecoder = (0, comments_1.createCommentParser)();
        while (!buffer.isEmpty()) {
          var currentFieldObj = void 0;
          if (0 < store.repeatCount) {
            currentFieldObj = {
              field: prevField,
              changed: false
            };
            store.repeatCount -= 1;
          } else {
            currentFieldObj = updateField(prevField.copy());
            if (!currentFieldObj.changed) {
              store.repeatCount = buffer.poll(1);
            }
          }
          var actionValue = buffer.poll(3);
          var action = actionDecoder.decode(actionValue);
          var comment = void 0;
          if (action.comment) {
            var commentValues = [];
            var commentLength = buffer.poll(2);
            for (var commentCounter = 0; commentCounter < Math.floor((commentLength + 3) / 4); commentCounter += 1) {
              var commentValue = buffer.poll(5);
              commentValues.push(commentValue);
            }
            var flatten = "";
            for (var _i = 0, commentValues_1 = commentValues; _i < commentValues_1.length; _i++) {
              var value = commentValues_1[_i];
              flatten += commentDecoder.decode(value);
            }
            var commentText = unescape(flatten.slice(0, commentLength));
            store.lastCommentText = commentText;
            comment = { text: commentText };
            store.refIndex.comment = pageIndex;
            var text = comment.text;
            if (quiz_1.Quiz.isQuizComment(text)) {
              try {
                store.quiz = new quiz_1.Quiz(text);
              } catch (e) {
                store.quiz = void 0;
              }
            } else {
              store.quiz = void 0;
            }
          } else if (pageIndex === 0) {
            comment = { text: "" };
          } else {
            comment = {
              text: store.quiz !== void 0 ? store.quiz.format().toString() : void 0,
              ref: store.refIndex.comment
            };
          }
          var quiz = false;
          if (store.quiz !== void 0) {
            quiz = true;
            if (store.quiz.canOperate() && action.lock) {
              if ((0, defines_1.isMinoPiece)(action.piece.type)) {
                try {
                  var nextQuiz = store.quiz.nextIfEnd();
                  var operation = nextQuiz.getOperation(action.piece.type);
                  store.quiz = nextQuiz.operate(operation);
                } catch (e) {
                  store.quiz = store.quiz.format();
                }
              } else {
                store.quiz = store.quiz.format();
              }
            }
          }
          var currentPiece = void 0;
          if (action.piece.type !== defines_1.Piece.Empty) {
            currentPiece = action.piece;
          }
          var field = void 0;
          if (currentFieldObj.changed || pageIndex === 0) {
            field = {};
            store.refIndex.field = pageIndex;
          } else {
            field = { ref: store.refIndex.field };
          }
          pages.push(new Page(pageIndex, currentFieldObj.field, currentPiece !== void 0 ? field_1.Mino.from({
            type: (0, defines_1.parsePieceName)(currentPiece.type),
            rotation: (0, defines_1.parseRotationName)(currentPiece.rotation),
            x: currentPiece.x,
            y: currentPiece.y
          }) : void 0, comment.text !== void 0 ? comment.text : store.lastCommentText, {
            quiz,
            lock: action.lock,
            mirror: action.mirror,
            colorize: action.colorize,
            rise: action.rise
          }, {
            field: field.ref,
            comment: comment.ref
          }));
          pageIndex += 1;
          if (action.lock) {
            if ((0, defines_1.isMinoPiece)(action.piece.type)) {
              currentFieldObj.field.fill(action.piece);
            }
            currentFieldObj.field.clearLine();
            if (action.rise) {
              currentFieldObj.field.riseGarbage();
            }
            if (action.mirror) {
              currentFieldObj.field.mirror();
            }
          }
          prevField = currentFieldObj.field;
        }
        return pages;
      }
    }
  });

  // node_modules/tetris-fumen/lib/encoder.js
  var require_encoder = __commonJS({
    "node_modules/tetris-fumen/lib/encoder.js"(exports) {
      "use strict";
      var __assign = exports && exports.__assign || function() {
        __assign = Object.assign || function(t) {
          for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
              t[p] = s[p];
          }
          return t;
        };
        return __assign.apply(this, arguments);
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.encode = void 0;
      var inner_field_1 = require_inner_field();
      var buffer_1 = require_buffer();
      var defines_1 = require_defines();
      var action_1 = require_action();
      var comments_1 = require_comments();
      var quiz_1 = require_quiz();
      var FieldConstants = {
        GarbageLine: 1,
        Width: 10
      };
      function encode(pages) {
        var updateField = function(prev, current) {
          var _a = encodeField(prev, current), changed = _a.changed, values = _a.values;
          if (changed) {
            buffer.merge(values);
            lastRepeatIndex = -1;
          } else if (lastRepeatIndex < 0 || buffer.get(lastRepeatIndex) === buffer_1.Buffer.tableLength - 1) {
            buffer.merge(values);
            buffer.push(0);
            lastRepeatIndex = buffer.length - 1;
          } else if (buffer.get(lastRepeatIndex) < buffer_1.Buffer.tableLength - 1) {
            var currentRepeatValue = buffer.get(lastRepeatIndex);
            buffer.set(lastRepeatIndex, currentRepeatValue + 1);
          }
        };
        var lastRepeatIndex = -1;
        var buffer = new buffer_1.Buffer();
        var prevField = (0, inner_field_1.createNewInnerField)();
        var actionEncoder = (0, action_1.createActionEncoder)(FieldConstants.Width, 23, FieldConstants.GarbageLine);
        var commentParser = (0, comments_1.createCommentParser)();
        var prevComment = "";
        var prevQuiz = void 0;
        var innerEncode = function(index2) {
          var currentPage = pages[index2];
          currentPage.flags = currentPage.flags ? currentPage.flags : {};
          var field = currentPage.field;
          var currentField = field !== void 0 ? (0, inner_field_1.createInnerField)(field) : prevField.copy();
          updateField(prevField, currentField);
          var currentComment = currentPage.comment !== void 0 ? index2 !== 0 || currentPage.comment !== "" ? currentPage.comment : void 0 : void 0;
          var piece = currentPage.operation !== void 0 ? {
            type: (0, defines_1.parsePiece)(currentPage.operation.type),
            rotation: (0, defines_1.parseRotation)(currentPage.operation.rotation),
            x: currentPage.operation.x,
            y: currentPage.operation.y
          } : {
            type: defines_1.Piece.Empty,
            rotation: defines_1.Rotation.Reverse,
            x: 0,
            y: 22
          };
          var nextComment;
          if (currentComment !== void 0) {
            if (currentComment.startsWith("#Q=")) {
              if (prevQuiz !== void 0 && prevQuiz.format().toString() === currentComment) {
                nextComment = void 0;
              } else {
                nextComment = currentComment;
                prevComment = nextComment;
                prevQuiz = new quiz_1.Quiz(currentComment);
              }
            } else {
              if (prevQuiz !== void 0 && prevQuiz.format().toString() === currentComment) {
                nextComment = void 0;
                prevComment = currentComment;
                prevQuiz = void 0;
              } else {
                nextComment = prevComment !== currentComment ? currentComment : void 0;
                prevComment = prevComment !== currentComment ? nextComment : prevComment;
                prevQuiz = void 0;
              }
            }
          } else {
            nextComment = void 0;
            prevQuiz = void 0;
          }
          if (prevQuiz !== void 0 && prevQuiz.canOperate() && currentPage.flags.lock) {
            if ((0, defines_1.isMinoPiece)(piece.type)) {
              try {
                var nextQuiz = prevQuiz.nextIfEnd();
                var operation = nextQuiz.getOperation(piece.type);
                prevQuiz = nextQuiz.operate(operation);
              } catch (e) {
                prevQuiz = prevQuiz.format();
              }
            } else {
              prevQuiz = prevQuiz.format();
            }
          }
          var currentFlags = __assign({ lock: true, colorize: index2 === 0 }, currentPage.flags);
          var action = {
            piece,
            rise: !!currentFlags.rise,
            mirror: !!currentFlags.mirror,
            colorize: !!currentFlags.colorize,
            lock: !!currentFlags.lock,
            comment: nextComment !== void 0
          };
          var actionNumber = actionEncoder.encode(action);
          buffer.push(actionNumber, 3);
          if (nextComment !== void 0) {
            var comment = escape(currentPage.comment);
            var commentLength = Math.min(comment.length, 4095);
            buffer.push(commentLength, 2);
            for (var index_1 = 0; index_1 < commentLength; index_1 += 4) {
              var value = 0;
              for (var count = 0; count < 4; count += 1) {
                var newIndex = index_1 + count;
                if (commentLength <= newIndex) {
                  break;
                }
                var ch = comment.charAt(newIndex);
                value += commentParser.encode(ch, count);
              }
              buffer.push(value, 5);
            }
          } else if (currentPage.comment === void 0) {
            prevComment = void 0;
          }
          if (action.lock) {
            if ((0, defines_1.isMinoPiece)(action.piece.type)) {
              currentField.fill(action.piece);
            }
            currentField.clearLine();
            if (action.rise) {
              currentField.riseGarbage();
            }
            if (action.mirror) {
              currentField.mirror();
            }
          }
          prevField = currentField;
        };
        for (var index = 0; index < pages.length; index += 1) {
          innerEncode(index);
        }
        var data = buffer.toString();
        if (data.length < 41) {
          return data;
        }
        var head = [data.substr(0, 42)];
        var tails = data.substring(42);
        var split = tails.match(/[\S]{1,47}/g) || [];
        return head.concat(split).join("?");
      }
      exports.encode = encode;
      function encodeField(prev, current) {
        var FIELD_TOP = 23;
        var FIELD_MAX_HEIGHT = FIELD_TOP + 1;
        var FIELD_BLOCKS = FIELD_MAX_HEIGHT * FieldConstants.Width;
        var buffer = new buffer_1.Buffer();
        var getDiff = function(xIndex2, yIndex2) {
          var y = FIELD_TOP - yIndex2 - 1;
          return current.getNumberAt(xIndex2, y) - prev.getNumberAt(xIndex2, y) + 8;
        };
        var recordBlockCounts = function(diff2, counter2) {
          var value = diff2 * FIELD_BLOCKS + counter2;
          buffer.push(value, 2);
        };
        var changed = true;
        var prev_diff = getDiff(0, 0);
        var counter = -1;
        for (var yIndex = 0; yIndex < FIELD_MAX_HEIGHT; yIndex += 1) {
          for (var xIndex = 0; xIndex < FieldConstants.Width; xIndex += 1) {
            var diff = getDiff(xIndex, yIndex);
            if (diff !== prev_diff) {
              recordBlockCounts(prev_diff, counter);
              counter = 0;
              prev_diff = diff;
            } else {
              counter += 1;
            }
          }
        }
        recordBlockCounts(prev_diff, counter);
        if (prev_diff === 8 && counter === FIELD_BLOCKS - 1) {
          changed = false;
        }
        return {
          changed,
          values: buffer
        };
      }
    }
  });

  // node_modules/tetris-fumen/index.js
  var require_tetris_fumen = __commonJS({
    "node_modules/tetris-fumen/index.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.encoder = exports.decoder = exports.Mino = exports.Field = void 0;
      var decoder_1 = require_decoder();
      var encoder_1 = require_encoder();
      var field_1 = require_field();
      Object.defineProperty(exports, "Field", { enumerable: true, get: function() {
        return field_1.Field;
      } });
      Object.defineProperty(exports, "Mino", { enumerable: true, get: function() {
        return field_1.Mino;
      } });
      exports.decoder = {
        decode: function(data) {
          return (0, decoder_1.decode)(data);
        }
      };
      exports.encoder = {
        encode: function(data) {
          return "v115@".concat((0, encoder_1.encode)(data));
        }
      };
    }
  });

  // public/stackingroyale/js/engine.js
  var require_engine = __commonJS({
    "public/stackingroyale/js/engine.js"(exports, module) {
      var { Field, Mino } = require_tetris_fumen();
      var PIECES = ["I", "O", "T", "S", "Z", "J", "L"];
      var ROTATIONS = ["spawn", "right", "reverse", "left"];
      var MAX_TIME = Number.MAX_SAFE_INTEGER;
      var MAX_GARBAGE = 200;
      var KICKS = {
        "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
        "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
        "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
        "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
        "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
        "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
        "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
        "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]
      };
      var I_KICKS = {
        "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
        "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
        "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
        "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
        "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
        "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
        "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
        "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]
      };
      var I_ORIGINS = [[0, 0], [1, 0], [1, -1], [0, -1]];
      function integer(value, minimum, maximum) {
        return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
      }
      function timer(value, maximum) {
        return Number.isFinite(value) && value >= 0 && value <= maximum;
      }
      function piece(value) {
        return PIECES.includes(value);
      }
      function packetValid(packet) {
        return packet && integer(packet.rows, 1, MAX_GARBAGE) && integer(packet.hole, 0, 9) && timer(packet.delayMs, 6e4) && (packet.sender === null || typeof packet.sender === "string" && packet.sender.length <= 128);
      }
      var Board = class _Board {
        constructor(seed = 0) {
          if (!integer(seed, 0, 4294967295)) throw new RangeError("Seed must be uint32");
          this._field = Field.create();
          this._state = {
            rng: seed,
            bag: [],
            next: [],
            active: null,
            hold: null,
            holdUsed: false,
            elapsedMs: 0,
            gravityMs: 0,
            lockMs: 0,
            lockResets: 0,
            lastRotation: null,
            lines: 0,
            locks: 0,
            combo: -1,
            b2b: false,
            label: "",
            over: false,
            garbage: [],
            clearRows: []
          };
          for (let index = 0; index < 5; index += 1) this._state.next.push(this._draw());
          this._spawn(this._takeNext(), []);
        }
        static from(snapshot) {
          const invalid = () => {
            throw new TypeError("Invalid Stacking Royale snapshot");
          };
          if (!snapshot || snapshot.version !== 1 || typeof snapshot.field !== "string" || !/^[IOTSZJLX_]{230}$/.test(snapshot.field)) invalid();
          if (!integer(snapshot.rng, 0, 4294967295) || !Array.isArray(snapshot.next) || snapshot.next.length !== 5 || !Array.from(snapshot.next).every(piece) || !Array.isArray(snapshot.bag) || snapshot.bag.length > 7 || !Array.from(snapshot.bag).every(piece) || new Set(snapshot.bag).size !== snapshot.bag.length || !(snapshot.hold === null || piece(snapshot.hold)) || typeof snapshot.holdUsed !== "boolean" || typeof snapshot.over !== "boolean" || typeof snapshot.b2b !== "boolean" || typeof snapshot.label !== "string" || snapshot.label.length > 128 || !timer(snapshot.elapsedMs, MAX_TIME) || !timer(snapshot.gravityMs, 800) || !timer(snapshot.lockMs, 500) || !integer(snapshot.lockResets, 0, 15) || !integer(snapshot.lines, 0, MAX_TIME) || !integer(snapshot.locks, 0, MAX_TIME) || !integer(snapshot.combo, -1, MAX_TIME) || snapshot.clearRows !== void 0 && (!Array.isArray(snapshot.clearRows) || snapshot.clearRows.length > 4 || !Array.from(snapshot.clearRows).every((row) => integer(row, -3, 19)) || new Set(snapshot.clearRows).size !== snapshot.clearRows.length) || !(snapshot.lastRotation === null || snapshot.lastRotation && integer(snapshot.lastRotation.kick, 0, 4)) || !Array.isArray(snapshot.garbage) || snapshot.garbage.length > MAX_GARBAGE || !Array.from(snapshot.garbage).every(packetValid) || snapshot.garbage.reduce((total, packet) => total + packet.rows, 0) > MAX_GARBAGE) invalid();
          const field = Field.create(snapshot.field);
          for (let row = 0; row < 23; row += 1) {
            if (Array.from({ length: 10 }, (_, column) => field.at(column, row)).every((cell) => cell !== "_")) invalid();
          }
          if (snapshot.over) {
            if (snapshot.active !== null) invalid();
          } else {
            const active = snapshot.active;
            if (!active || !piece(active.type) || !ROTATIONS.includes(active.rotation) || !integer(active.x, -2, 11) || !integer(active.y, 0, 22) || !Mino.from(active).isValid() || !field.canFill(active)) invalid();
          }
          const board = Object.create(_Board.prototype);
          board._field = field;
          board._state = {
            rng: snapshot.rng,
            bag: [...snapshot.bag],
            next: [...snapshot.next],
            active: snapshot.active === null ? null : Mino.from(snapshot.active).operation(),
            hold: snapshot.hold,
            holdUsed: snapshot.holdUsed,
            elapsedMs: snapshot.elapsedMs,
            gravityMs: snapshot.gravityMs,
            lockMs: snapshot.lockMs,
            lockResets: snapshot.lockResets,
            lastRotation: snapshot.lastRotation === null ? null : { kick: snapshot.lastRotation.kick },
            lines: snapshot.lines,
            locks: snapshot.locks,
            combo: snapshot.combo,
            clearRows: [...snapshot.clearRows || []],
            b2b: snapshot.b2b,
            label: snapshot.label,
            over: snapshot.over,
            garbage: snapshot.garbage.map((packet) => ({ rows: packet.rows, hole: packet.hole, delayMs: packet.delayMs, sender: packet.sender }))
          };
          return board;
        }
        get over() {
          return this._state.over;
        }
        snapshot() {
          const state = this._state;
          return {
            version: 1,
            ...state,
            field: this._field.str({ reduced: false, garbage: false, separator: "" }),
            active: state.active === null ? null : { ...state.active },
            bag: [...state.bag],
            next: [...state.next],
            clearRows: [...state.clearRows],
            lastRotation: state.lastRotation === null ? null : { ...state.lastRotation },
            garbage: state.garbage.map((packet) => ({ ...packet }))
          };
        }
        view() {
          const state = this._state;
          const cells = (operation) => operation === null ? [] : Mino.from(operation).positions().map((position) => ({ x: position.x, y: 19 - position.y, type: operation.type }));
          return {
            grid: Array.from({ length: 20 }, (_, row) => Array.from({ length: 10 }, (_2, column) => this._field.at(column, 19 - row))),
            active: cells(state.active),
            ghost: cells(this._ghost()),
            hold: state.hold,
            next: [...state.next],
            lines: state.lines,
            level: this._level(),
            elapsedMs: state.elapsedMs,
            over: state.over,
            combo: state.combo,
            label: state.label,
            locks: state.locks,
            clearRows: [...state.clearRows],
            incoming: state.garbage.reduce((total, packet) => total + packet.rows, 0)
          };
        }
        enqueueGarbage(rows, hole, delayMs = 1500, sender = null) {
          const packet = { rows, hole, delayMs, sender };
          if (!packetValid(packet)) throw new RangeError("Invalid garbage packet");
          if (this.over) return;
          packet.rows = Math.min(rows, MAX_GARBAGE - this.view().incoming);
          if (packet.rows > 0) this._state.garbage.push(packet);
        }
        action(name) {
          const events = [];
          if (this.over) return events;
          const state = this._state;
          if (name === "left" || name === "right") this._move(name === "left" ? -1 : 1, 0, true);
          else if (name === "soft") this._move(0, -1, false);
          else if (name === "rotateCW" || name === "rotateCCW") this._rotate(name === "rotateCW" ? 1 : -1);
          else if (name === "hold" && !state.holdUsed) {
            const previous = state.hold;
            state.hold = state.active.type;
            state.holdUsed = true;
            this._spawn(previous === null ? this._takeNext() : previous, events);
          } else if (name === "drop") {
            const landing = this._ghost();
            if (landing.y !== state.active.y) state.lastRotation = null;
            state.active = landing;
            this._lock(events);
          }
          return events;
        }
        step(ms) {
          if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIME - this._state.elapsedMs) {
            throw new RangeError("Step must be finite positive milliseconds within the safe time range");
          }
          const events = [];
          let remaining = ms;
          while (remaining > 0 && !this.over) {
            const state = this._state;
            const grounded = this._field.canLock(state.active);
            const gravity = this._gravity();
            const untilLevel = 3e4 - state.elapsedMs % 3e4;
            const delta = Math.min(
              remaining,
              1e3 / 60,
              untilLevel,
              Math.max(0, gravity - state.gravityMs),
              grounded ? Math.max(0, 500 - state.lockMs) : Infinity
            );
            state.elapsedMs += delta;
            state.gravityMs += delta;
            if (grounded) state.lockMs += delta;
            for (const packet of state.garbage) packet.delayMs = Math.max(0, packet.delayMs - delta);
            remaining = Math.max(0, remaining - delta);
            if (grounded && state.lockMs >= 500 - 1e-8) {
              this._lock(events);
            } else if (state.gravityMs >= this._gravity() - 1e-8) {
              state.gravityMs = Math.max(0, state.gravityMs - this._gravity());
              this._move(0, -1, false);
            }
          }
          return events;
        }
        _level() {
          return Math.floor(this._state.elapsedMs / 3e4) + 1;
        }
        _gravity() {
          return Math.max(70, 800 - (this._level() - 1) * 60);
        }
        _draw() {
          const state = this._state;
          if (state.bag.length === 0) {
            state.bag = [...PIECES];
            for (let index = 6; index > 0; index -= 1) {
              state.rng = Math.imul(state.rng, 1664525) + 1013904223 >>> 0;
              const other = Math.floor(state.rng / 4294967296 * (index + 1));
              [state.bag[index], state.bag[other]] = [state.bag[other], state.bag[index]];
            }
          }
          return state.bag.shift();
        }
        _takeNext() {
          const next = this._state.next.shift();
          this._state.next.push(this._draw());
          return next;
        }
        _spawn(type, events) {
          const state = this._state;
          state.active = new Mino(type, "spawn", 4, 20).operation();
          state.gravityMs = 0;
          state.lockMs = 0;
          state.lockResets = 0;
          state.lastRotation = null;
          if (!this._field.canFill(state.active)) this._topout(events);
        }
        _topout(events) {
          if (this.over) return;
          this._state.over = true;
          this._state.active = null;
          events.push({ type: "topout" });
        }
        _ghost() {
          if (this._state.active === null) return null;
          const ghost = { ...this._state.active };
          while (this._field.canFill({ ...ghost, y: ghost.y - 1 })) ghost.y -= 1;
          return ghost;
        }
        _resetLock(wasGrounded) {
          const state = this._state;
          if (wasGrounded && state.lockResets < 15) {
            state.lockMs = 0;
            state.lockResets += 1;
          }
        }
        _move(horizontal, vertical, reset) {
          const state = this._state;
          const candidate = { ...state.active, x: state.active.x + horizontal, y: state.active.y + vertical };
          if (!this._field.canFill(candidate)) return false;
          const grounded = this._field.canLock(state.active);
          state.active = candidate;
          state.lastRotation = null;
          if (reset) this._resetLock(grounded);
          return true;
        }
        _rotate(direction) {
          const state = this._state;
          const active = state.active;
          if (active.type === "O") return false;
          const before = ROTATIONS.indexOf(active.rotation);
          const after = (before + direction + 4) % 4;
          const kicks = (active.type === "I" ? I_KICKS : KICKS)[`${before}>${after}`];
          const originBefore = active.type === "I" ? I_ORIGINS[before] : [0, 0];
          const originAfter = active.type === "I" ? I_ORIGINS[after] : [0, 0];
          for (let index = 0; index < kicks.length; index += 1) {
            const [horizontal, vertical] = kicks[index];
            const candidate = new Mino(
              active.type,
              ROTATIONS[after],
              active.x + originAfter[0] - originBefore[0] + horizontal,
              active.y + originAfter[1] - originBefore[1] + vertical
            ).operation();
            if (!this._field.canFill(candidate)) continue;
            const grounded = this._field.canLock(active);
            state.active = candidate;
            state.lastRotation = { kick: index };
            this._resetLock(grounded);
            return true;
          }
          return false;
        }
        _spin() {
          const state = this._state;
          const active = state.active;
          if (active.type !== "T" || state.lastRotation === null) return null;
          const occupied = (horizontal, vertical) => {
            const column = active.x + horizontal;
            const row = active.y + vertical;
            return column < 0 || column > 9 || row < 0 || row > 22 || this._field.at(column, row) !== "_";
          };
          const corners = [occupied(-1, 1), occupied(1, 1), occupied(1, -1), occupied(-1, -1)];
          if (corners.filter(Boolean).length < 3) return null;
          const front = ROTATIONS.indexOf(active.rotation);
          return corners[front] && corners[(front + 1) % 4] || state.lastRotation.kick === 4 ? "full" : "mini";
        }
        _lock(events) {
          const state = this._state;
          const spin = this._spin();
          const hidden = Mino.from(state.active).positions().every((position) => position.y >= 20);
          this._field.fill(state.active);
          state.clearRows = [];
          for (let row = 0; row < 23; row += 1) {
            if (Array.from({ length: 10 }, (_, column) => this._field.at(column, row)).every((cell) => cell !== "_")) state.clearRows.push(19 - row);
          }
          const cleared = state.clearRows.length;
          this._field.clearLine();
          const perfectClear = this._field.str({ garbage: false, separator: "" }) === "";
          const difficult = cleared > 0 && (cleared === 4 || spin !== null);
          let attack = spin === "full" ? [0, 2, 4, 6][cleared] : spin === "mini" ? [0, 0, 1][cleared] : [0, 0, 1, 2, 4][cleared];
          if (cleared > 0) {
            state.combo += 1;
            attack += Math.min(4, Math.floor(state.combo / 2));
            if (difficult && state.b2b) attack += 1;
            state.b2b = difficult;
          } else state.combo = -1;
          if (perfectClear) attack += 10;
          for (const packet of state.garbage) {
            const cancelled = Math.min(attack, packet.rows);
            packet.rows -= cancelled;
            attack -= cancelled;
          }
          state.garbage = state.garbage.filter((packet) => packet.rows > 0);
          state.lines += cleared;
          state.locks += 1;
          state.label = perfectClear ? "Perfect Clear" : spin !== null ? `${spin === "mini" ? "Mini T-Spin" : "T-Spin"}${cleared ? ` ${cleared}` : ""}` : ["", "Single", "Double", "Triple", "Tetris"][cleared];
          events.push({ type: "lock", lines: cleared, clearRows: [...state.clearRows], attack, label: state.label, perfectClear, spin });
          state.active = null;
          if (hidden && cleared === 0) {
            this._topout(events);
            return;
          }
          if (cleared === 0) this._applyGarbage(events);
          if (this.over) return;
          state.holdUsed = false;
          this._spawn(this._takeNext(), events);
        }
        _applyGarbage(events) {
          let applied = 0;
          for (const packet of this._state.garbage) {
            if (packet.delayMs > 0) continue;
            while (packet.rows > 0 && applied < 8) {
              for (let column = 0; column < 10; column += 1) {
                if (this._field.at(column, 22) !== "_") {
                  this._topout(events);
                  this._state.garbage = this._state.garbage.filter((pending) => pending.rows > 0);
                  return;
                }
              }
              for (let row = 22; row > 0; row -= 1) {
                for (let column = 0; column < 10; column += 1) this._field.set(column, row, this._field.at(column, row - 1));
              }
              for (let column = 0; column < 10; column += 1) this._field.set(column, 0, column === packet.hole ? "_" : "X");
              packet.rows -= 1;
              applied += 1;
            }
          }
          this._state.garbage = this._state.garbage.filter((packet) => packet.rows > 0);
        }
      };
      module.exports = { Board };
    }
  });
  return require_engine();
})();
