module packetizer (
    input wire clk,
    input wire rst,
    input wire sample_valid,
    input wire [11:0] sample_data,
    output wire packet_valid,
    output wire [15:0] packet_data
);
    wire [15:0] framed_data;

    framer u_framer (
        .sample_data(sample_data),
        .framed_data(framed_data)
    );

    crc8 u_crc8 (
        .data_in(framed_data[7:0]),
        .crc_out(packet_data[7:0])
    );

    assign packet_data[15:8] = framed_data[15:8];
    assign packet_valid = sample_valid;
endmodule
