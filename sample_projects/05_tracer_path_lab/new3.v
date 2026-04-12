module new3 (
    input wire input1,
    input wire input2,
    output reg output1
);

  always @(*) begin
    output1 = input1 & input2;
  end

endmodule