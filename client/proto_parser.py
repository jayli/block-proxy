"""
Minimal protobuf wire format parser.
No external dependencies — handles varint, length-delimited, and varint wire types.
"""


def read_varint(data, offset):
    """Read a protobuf varint from data at offset.
    Returns (value, bytes_consumed).
    """
    result = 0
    shift = 0
    pos = offset
    while pos < len(data):
        byte = data[pos]
        result |= (byte & 0x7F) << shift
        pos += 1
        if not (byte & 0x80):
            break
        shift += 7
    return result, pos - offset


def parse_message(data):
    """Parse a protobuf message into a list of (field_number, wire_type, value) tuples.

    wire_type 0 → value is int (varint)
    wire_type 2 → value is bytes (string/bytes/embedded message)
    wire_type 1 → value is bytes (8 bytes, fixed64)
    wire_type 5 → value is bytes (4 bytes, fixed32)
    """
    fields = []
    offset = 0
    while offset < len(data):
        tag, consumed = read_varint(data, offset)
        offset += consumed
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:  # varint
            value, consumed = read_varint(data, offset)
            offset += consumed
        elif wire_type == 2:  # length-delimited
            length, consumed = read_varint(data, offset)
            offset += consumed
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 1:  # 64-bit
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 5:  # 32-bit
            value = data[offset:offset + 4]
            offset += 4
        else:
            break  # unknown wire type
        fields.append((field_number, wire_type, value))
    return fields


def get_varint(fields, field_number, default=None):
    """Get a varint field value by field_number."""
    for fn, wt, val in fields:
        if fn == field_number and wt == 0:
            return val
    return default


def get_string(fields, field_number, default=None):
    """Get a string field value by field_number."""
    for fn, wt, val in fields:
        if fn == field_number and wt == 2:
            return val.decode("utf-8")
    return default


def get_bytes(fields, field_number, default=None):
    """Get a bytes field value by field_number."""
    for fn, wt, val in fields:
        if fn == field_number and wt == 2:
            return val
    return default


def get_message(fields, field_number, default=None):
    """Get an embedded message as parsed fields by field_number."""
    for fn, wt, val in fields:
        if fn == field_number and wt == 2:
            return parse_message(val)
    return default
