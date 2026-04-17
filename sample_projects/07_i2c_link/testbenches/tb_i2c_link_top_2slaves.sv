`timescale 1ns/1ps

module tb_i2c_link_top_2slaves;
  reg clk = 0;
  reg rst = 1;

  reg start_write = 0;
  reg [1:0] slave_sel = 0;
  reg [7:0] tx_data = 8'h00;

  wire busy, done, ack_error;
  wire [7:0] slave0_rx_data, slave1_rx_data, slave2_rx_data;
  wire slave0_rx_valid, slave1_rx_valid, slave2_rx_valid;
  wire i2c_scl, i2c_sda;

  i2c_link_top #(
    .CLK_DIV(4),
    .SLAVE_ADDRESS(7'h42),
    .SLAVE1_ADDRESS(7'h43),
    .SLAVE2_ADDRESS(7'h44)
  ) dut (
    .clk(clk),
    .rst(rst),
    .start_write(start_write),
    .slave_sel(slave_sel),
    .slave_rx_data(),
    .slave_rx_valid(),
    .tx_data(tx_data),
    .busy(busy),
    .done(done),
    .ack_error(ack_error),
    .slave0_rx_data(slave0_rx_data),
    .slave0_rx_valid(slave0_rx_valid),
    .slave1_rx_data(slave1_rx_data),
    .slave1_rx_valid(slave1_rx_valid),
    .slave2_rx_data(slave2_rx_data),
    .slave2_rx_valid(slave2_rx_valid),
    .i2c_scl(i2c_scl),
    .i2c_sda(i2c_sda)
  );

  always #5 clk = ~clk;

  task automatic pulse_start;
    begin
      @(negedge clk);
      start_write <= 1'b1;
      @(negedge clk);
      start_write <= 1'b0;
    end
  endtask

  task automatic wait_done;
    input [1023:0] label;
    output ok;
    integer i;
    begin
      ok = 1'b0;
      for (i=0; i<2000; i=i+1) begin
        @(posedge clk);
        if (done) begin
          ok = 1'b1;
          disable wait_done;
        end
      end
      $display("FAIL [t=%0t] %0s: done never asserted", $time, label);
    end
  endtask

  task automatic do_write;
    input [1:0] sel;
    input [7:0] data;
    input [1023:0] label;
    reg ok;
    begin
      // clear any previous valids by waiting a little (rx_valid is a pulse)
      repeat (5) @(posedge clk);
      slave_sel <= sel;
      tx_data <= data;
      pulse_start();
      wait_done(label, ok);
      @(posedge clk);

      if (!ok) begin end
      else if (ack_error) $display("FAIL [t=%0t] %0s: ack_error unexpectedly high", $time, label);
      else if (sel==2'd0) begin
        if (!slave0_rx_valid)
          $display("FAIL [t=%0t] %0s: slave0_rx_valid low", $time, label);
        else if (slave0_rx_data !== data)
          $display("FAIL [t=%0t] %0s: slave0_rx_data got=%0h expected=%0h", $time, label, slave0_rx_data, data);
        else if (slave1_rx_valid || slave2_rx_valid)
          $display("FAIL [t=%0t] %0s: other slave_rx_valid unexpectedly high (s1=%b s2=%b)", $time, label, slave1_rx_valid, slave2_rx_valid);
        else
          $display("PASS [t=%0t] %0s", $time, label);
      end else if (sel==2'd1) begin
        if (!slave1_rx_valid)
          $display("FAIL [t=%0t] %0s: slave1_rx_valid low", $time, label);
        else if (slave1_rx_data !== data)
          $display("FAIL [t=%0t] %0s: slave1_rx_data got=%0h expected=%0h", $time, label, slave1_rx_data, data);
        else if (slave0_rx_valid || slave2_rx_valid)
          $display("FAIL [t=%0t] %0s: other slave_rx_valid unexpectedly high (s0=%b s2=%b)", $time, label, slave0_rx_valid, slave2_rx_valid);
        else
          $display("PASS [t=%0t] %0s", $time, label);
      end else if (sel==2'd2) begin
        if (!slave2_rx_valid)
          $display("FAIL [t=%0t] %0s: slave2_rx_valid low", $time, label);
        else if (slave2_rx_data !== data)
          $display("FAIL [t=%0t] %0s: slave2_rx_data got=%0h expected=%0h", $time, label, slave2_rx_data, data);
        else if (slave0_rx_valid || slave1_rx_valid)
          $display("FAIL [t=%0t] %0s: other slave_rx_valid unexpectedly high (s0=%b s1=%b)", $time, label, slave0_rx_valid, slave1_rx_valid);
        else
          $display("PASS [t=%0t] %0s", $time, label);
      end else begin
        $display("FAIL [t=%0t] %0s: illegal sel=%0d", $time, label, sel);
      end
    end
  endtask

  initial begin
    $dumpfile("tb_i2c_link_top_2slaves.vcd");
    $dumpvars(0, tb_i2c_link_top_2slaves);

    repeat (5) @(posedge clk);
    rst <= 1'b0;
    repeat (5) @(posedge clk);

    if (!$test$plusargs("test_slave0_only") && !$test$plusargs("test_slave1_only")) begin
      do_write(2'd0, 8'hA5, "SEL0 write 0xA5 -> slave0");
      do_write(2'd1, 8'h5A, "SEL1 write 0x5A -> slave1");
      do_write(2'd2, 8'h3C, "SEL2 write 0x3C -> slave2");
      do_write(2'd0, 8'hC3, "SEL0 second write 0xC3 -> slave0");
      do_write(2'd1, 8'h69, "SEL1 second write 0x69 -> slave1");
      do_write(2'd2, 8'h96, "SEL2 second write 0x96 -> slave2");
    end

    if ($test$plusargs("test_slave0_only")) begin
      do_write(1'b0, 8'h11, "SEL0 only write 0x11 -> slave0");
      do_write(1'b0, 8'h22, "SEL0 only write 0x22 -> slave0");
    end

    if ($test$plusargs("test_slave1_only")) begin
      do_write(1'b1, 8'h33, "SEL1 only write 0x33 -> slave1");
      do_write(1'b1, 8'h44, "SEL1 only write 0x44 -> slave1");
    end

    #200;
    $finish;
  end
endmodule
