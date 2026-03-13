module priority_mux (
    input wire sel,
    input wire [7:0] a,
    input wire [7:0] b,
    output wire [7:0] y
);
    assign y = sel ? a : b;
endmodule
