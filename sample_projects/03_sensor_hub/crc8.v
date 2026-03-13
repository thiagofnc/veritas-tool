module crc8 (
    input wire [7:0] data_in,
    output wire [7:0] crc_out
);
    assign crc_out = data_in ^ 8'h5A;
endmodule
