import struct
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from proto_parser import (
    read_varint, parse_message,
    get_varint, get_string, get_bytes, get_message,
)


def _encode_varint(value):
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def _encode_tag(field_number, wire_type):
    return _encode_varint((field_number << 3) | wire_type)


def _encode_string_field(field_number, value):
    data = value.encode("utf-8")
    return _encode_tag(field_number, 2) + _encode_varint(len(data)) + data


def _encode_bytes_field(field_number, value):
    return _encode_tag(field_number, 2) + _encode_varint(len(value)) + value


def _encode_varint_field(field_number, value):
    return _encode_tag(field_number, 0) + _encode_varint(value)


def _encode_message_field(field_number, message_bytes):
    return _encode_tag(field_number, 2) + _encode_varint(len(message_bytes)) + message_bytes


class TestReadVarint:
    def test_single_byte(self):
        data = _encode_varint(1)
        val, consumed = read_varint(data, 0)
        assert val == 1
        assert consumed == 1

    def test_multi_byte(self):
        data = _encode_varint(300)
        val, consumed = read_varint(data, 0)
        assert val == 300
        assert consumed == 2

    def test_zero(self):
        data = _encode_varint(0)
        val, consumed = read_varint(data, 0)
        assert val == 0
        assert consumed == 1

    def test_with_offset(self):
        data = b'\x01' + _encode_varint(150)  # skip first byte
        val, consumed = read_varint(data, 1)
        assert val == 150
        assert consumed == 2


class TestParseMessage:
    def test_empty_message(self):
        result = parse_message(b'')
        assert result == []

    def test_varint_field(self):
        data = _encode_varint_field(1, 42)
        result = parse_message(data)
        assert len(result) == 1
        assert result[0] == (1, 0, 42)

    def test_string_field(self):
        data = _encode_string_field(3, "hello")
        result = parse_message(data)
        assert len(result) == 1
        fn, wt, val = result[0]
        assert fn == 3
        assert wt == 2
        assert val == b"hello"

    def test_multiple_fields(self):
        data = _encode_varint_field(1, 10) + _encode_string_field(2, "world")
        result = parse_message(data)
        assert len(result) == 2
        assert result[0] == (1, 0, 10)
        fn2, wt2, val2 = result[1]
        assert fn2 == 2
        assert wt2 == 2
        assert val2 == b"world"


class TestFieldGetters:
    def test_get_varint(self):
        data = _encode_varint_field(1, 99)
        fields = parse_message(data)
        assert get_varint(fields, 1) == 99

    def test_get_string(self):
        data = _encode_string_field(2, "test")
        fields = parse_message(data)
        assert get_string(fields, 2) == "test"

    def test_get_bytes(self):
        raw = b'\x00\x01\x02'
        data = _encode_bytes_field(3, raw)
        fields = parse_message(data)
        assert get_bytes(fields, 3) == raw

    def test_get_message(self):
        inner = _encode_varint_field(1, 7) + _encode_string_field(2, "inner_val")
        data = _encode_message_field(4, inner)
        fields = parse_message(data)
        inner_fields = get_message(fields, 4)
        assert get_varint(inner_fields, 1) == 7
        assert get_string(inner_fields, 2) == "inner_val"

    def test_get_message_returns_none_for_missing(self):
        data = _encode_varint_field(1, 1)
        fields = parse_message(data)
        assert get_message(fields, 99) is None

    def test_get_all_repeated(self):
        inner1 = _encode_varint_field(1, 1)
        inner2 = _encode_varint_field(1, 2)
        data = _encode_message_field(5, inner1) + _encode_message_field(5, inner2)
        fields = parse_message(data)
        # Both messages should be parsed; get_message returns the first one by default
        msg1 = get_message(fields, 5)
        assert get_varint(msg1, 1) == 1
        # Verify both repeated fields are in the list
        repeated = [(fn, wt, val) for fn, wt, val in fields if fn == 5 and wt == 2]
        assert len(repeated) == 2
