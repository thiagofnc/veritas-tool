module framer (
    input wire [11:0] sample_data,
    output wire [15:0] framed_data
);
    assign framed_data = {4'hA, sample_data};
endmodule
