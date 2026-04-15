module uart_rx (
    input wire clk,
    input wire rst,
    input wire baud_tick,
    input wire rx,
    output reg [7:0] data_out,
    output reg data_valid,
    output reg frame_error,
    output reg busy
);
    localparam [1:0] STATE_IDLE = 2'd0;
    localparam [1:0] STATE_DATA = 2'd1;
    localparam [1:0] STATE_STOP = 2'd2;

    reg [1:0] state;
    reg [7:0] shift_reg;
    reg [2:0] bit_index;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            state <= STATE_IDLE;
            shift_reg <= 8'd0;
            bit_index <= 3'd0;
            data_out <= 8'd0;
            data_valid <= 1'b0;
            frame_error <= 1'b0;
            busy <= 1'b0;
        end else begin
            data_valid <= 1'b0;
            frame_error <= 1'b0;

            if (baud_tick) begin
                case (state)
                    STATE_IDLE: begin
                        busy <= 1'b0;
                        bit_index <= 3'd0;
                        if (!rx) begin
                            state <= STATE_DATA;
                            busy <= 1'b1;
                        end
                    end

                    STATE_DATA: begin
                        shift_reg[bit_index] <= rx;
                        if (bit_index == 3'd7) begin
                            state <= STATE_STOP;
                        end else begin
                            bit_index <= bit_index + 3'd1;
                        end
                    end

                    STATE_STOP: begin
                        state <= STATE_IDLE;
                        busy <= 1'b0;
                        data_out <= shift_reg;
                        data_valid <= rx;
                        frame_error <= ~rx;
                    end

                    default: begin
                        state <= STATE_IDLE;
                        busy <= 1'b0;
                    end
                endcase
            end
        end
    end
endmodule
